const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const express = require('express');
const os = require('os'); 
const crypto = require('crypto');
const { spawn } = require('child_process');
const xlsx = require('xlsx'); // Smart Excel Library
const mammoth = require('mammoth'); // Smart Word Parser
const JSZip = require('jszip'); // Used to inspect Word run colors/highlights
const expressApp = express();
const PORT = 3000;

expressApp.use(express.json());
expressApp.use(express.urlencoded({ extended: true }));

const quizQueryWithCount = "SELECT quizzes.*, (SELECT COUNT(*) FROM questions WHERE questions.quiz_title = quizzes.title) AS uploaded_count FROM quizzes ORDER BY id DESC";
const activeQuizWithInstructorQuery = "SELECT quizzes.*, IFNULL(subjects.instructor_name, '') AS instructor_name, (SELECT COUNT(*) FROM questions WHERE questions.quiz_title = quizzes.title) AS uploaded_count FROM quizzes LEFT JOIN subjects ON subjects.subject_name = quizzes.subject WHERE IFNULL(quizzes.is_archived, 0) = 0 ORDER BY quizzes.id DESC";
// v2.1.4 Incident Logging: every proctoring warning increments exam_incidents.
// Both read queries expose that tally so the Admin tables can show a badge.
const incidentCountForResult = `IFNULL((SELECT exam_incidents.incident_count FROM exam_incidents WHERE exam_incidents.student_id = results.student_id AND exam_incidents.quiz_title = results.quiz_title LIMIT 1), 0) as incident_count`;
const resultsWithSectionQuery = `SELECT results.*, IFNULL(students.course_section, 'Unknown') as course_section, ${incidentCountForResult} FROM results LEFT JOIN students ON results.student_id = students.student_id ORDER BY results.id DESC`;

// ============================================================================
// v2.1.4: SMART STUDENT ROSTER / EXAM VISIBILITY
// ============================================================================
function normalizeRosterValue(value) {
    return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

function splitRosterSections(value) {
    return String(value === null || value === undefined ? '' : value)
        .split(',')
        .map(section => section.trim().toLowerCase())
        .filter(Boolean);
}

function targetSectionMatchesStudent(studentSections, targetSection) {
    const target = normalizeRosterValue(targetSection);
    if (!target || target === 'all sections') return true;
    return (studentSections || []).some(section => section.includes(target) || target.includes(section));
}

// Rebuilds the lightweight student_roster mapping used to scope exam access.
// Only section-targeted quizzes get explicit rows; "All Sections" quizzes fall
// back to the instructor/section rules in getVisibleQuizzesForStudent().
function rebuildAllRosters(callback) {
    db.all("SELECT title, target_section FROM quizzes WHERE IFNULL(is_archived, 0) = 0", [], (err, quizRows) => {
        db.all("SELECT student_id, course_section FROM students", [], (err2, studentRows) => {
            const sectionQuizzes = (quizRows || []).filter(q => {
                const target = normalizeRosterValue(q.target_section);
                return target && target !== 'all sections';
            });
            const students = studentRows || [];

            db.run("DELETE FROM student_roster", [], (deleteErr) => {
                if (deleteErr || sectionQuizzes.length === 0 || students.length === 0) {
                    if (typeof callback === 'function') callback();
                    return;
                }

                const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const stmt = db.prepare("INSERT OR IGNORE INTO student_roster (student_id, quiz_title, assigned_by, date_assigned) VALUES (?, ?, ?, ?)");

                sectionQuizzes.forEach(quiz => {
                    const target = normalizeRosterValue(quiz.target_section);
                    students.forEach(student => {
                        const sections = splitRosterSections(student.course_section);
                        if (sections.some(section => section.includes(target) || target.includes(section))) {
                            stmt.run([String(student.student_id || ''), String(quiz.title || ''), 'Auto-Roster', today]);
                        }
                    });
                });

                stmt.finalize(() => {
                    if (typeof callback === 'function') callback();
                });
            });
        });
    });
}

function getVisibleQuizzesForStudent(studentId, callback) {
    const cleanId = String(studentId || '').trim();
    if (!cleanId) {
        db.all(activeQuizWithInstructorQuery, [], (err, rows) => callback(rows || []));
        return;
    }

    db.get("SELECT * FROM students WHERE student_id = ?", [cleanId], (err, student) => {
        if (!student) {
            callback([]);
            return;
        }

        db.all(activeQuizWithInstructorQuery, [], (err2, quizRows) => {
            const allQuizzes = quizRows || [];

            db.all("SELECT quiz_title, student_id FROM student_roster", [], (err3, rosterRows) => {
                const assignedTitles = new Set();
                const studentTitles = new Set();

                (rosterRows || []).forEach(row => {
                    const title = String(row.quiz_title || '');
                    assignedTitles.add(title);
                    if (String(row.student_id || '') === cleanId) studentTitles.add(title);
                });

                const studentSections = splitRosterSections(student.course_section);
                const owner = normalizeRosterValue(student.registered_by);
                const ownsAnySubject = !!owner && owner !== 'administrator' &&
                    allQuizzes.some(q => normalizeRosterValue(q.instructor_name) === owner);

                const visible = allQuizzes.filter(quiz => {
                    const title = String(quiz.title || '');

                    // Explicit roster rows win: if a quiz has a roster, the student
                    // must be on it. Quizzes without roster rows use section rules.
                    if (assignedTitles.has(title)) {
                        if (!studentTitles.has(title)) return false;
                    } else if (!targetSectionMatchesStudent(studentSections, quiz.target_section)) {
                        return false;
                    }

                    // Once we can prove which instructor uploaded this student,
                    // hide subjects owned by other instructors.
                    if (ownsAnySubject) {
                        const instructor = normalizeRosterValue(quiz.instructor_name);
                        if (instructor && instructor !== owner) return false;
                    }

                    return true;
                });

                callback(visible);
            });
        });
    });
}

// ============================================================================
// 3-LAYER ANTI-PROXY SECURITY STATE (WHITEBOARD + AUTO-GATEKEEPER WORKFLOW)
// ============================================================================
let isExamRoomLocked = false; // Layer 2: Gatekeeper Room Lock
let expectedStudentCount = 0; // Optional target headcount for automatic room lock (0 = manual)
const activeStudentSessions = new Map(); // Layer 1: studentId -> { token, studentName, time }
const redeemedStudentPins = new Map();   // Layer 3: `${studentId}___${quizTitle}` -> clientToken
const unlockedStudentIds = new Set();    // Tracks unique studentIds that have redeemed the live PIN
let dynamicRoomPin = String(Math.floor(1000 + Math.random() * 9000));

// A student browser that stops sending heartbeats (crash, closed laptop, killed tab)
// keeps its device lock for this grace period before the seat is released.
const SESSION_HEARTBEAT_TIMEOUT_MS = 45000;
const SESSION_SWEEP_INTERVAL_MS = 15000;

function purgeStaleStudentSessions() {
    const now = Date.now();
    let removed = 0;
    for (const [studentId, session] of activeStudentSessions) {
        const lastSeen = session.lastSeen || session.time || 0;
        if (now - lastSeen > SESSION_HEARTBEAT_TIMEOUT_MS) {
            activeStudentSessions.delete(studentId);
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`🔓 Released ${removed} stale student session lock(s).`);
        broadcastSecurityState();
    }
}

setInterval(purgeStaleStudentSessions, SESSION_SWEEP_INTERVAL_MS);

function checkAutoGatekeeperLock() {
    if (
        !isExamRoomLocked &&
        expectedStudentCount > 0 &&
        activeStudentSessions.size >= expectedStudentCount &&
        unlockedStudentIds.size >= expectedStudentCount &&
        unlockedStudentIds.size >= activeStudentSessions.size
    ) {
        isExamRoomLocked = true;
        // Automatically retire the whiteboard PIN when auto-lock triggers
        dynamicRoomPin = String(Math.floor(1000 + Math.random() * 9000));
        return true;
    }
    return false;
}

function broadcastSecurityState() {
    const adminWindow = BrowserWindow.getAllWindows()[0];
    if (adminWindow) {
        adminWindow.webContents.send('security-state-update', {
            isLocked: isExamRoomLocked,
            connectedCount: activeStudentSessions.size,
            unlockedCount: unlockedStudentIds.size,
            expectedCount: expectedStudentCount,
            dynamicPin: dynamicRoomPin,
            pinSeconds: isExamRoomLocked ? 'LOCKED' : 'LIVE'
        });
    }
}

function sendAdminCheatAlert(student_name, quiz_title, reason = 'Security Violation') {
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    const adminWindow = BrowserWindow.getAllWindows()[0];
    if (adminWindow) {
        adminWindow.webContents.send('trigger-cheat-alarm', { student_name, quiz_title, time, reason });
    }
}

expressApp.post('/api/student-login', (req, res) => {
    const { studentId, clientToken } = req.body;
    const cleanId = (studentId || '').trim();

    db.get("SELECT * FROM students WHERE student_id = ?", [cleanId], (err, row) => {
        if (!row) {
            return res.json({ success: false, message: "Student ID not found. Please ask the instructor to register you." });
        }

        const existingSession = activeStudentSessions.get(cleanId);

        // LAYER 1: Check if this Student ID is already active on a browser
        if (existingSession) {
            if (clientToken && existingSession.token === clientToken) {
                // Same device reconnecting or refreshing page — allow seamlessly
                existingSession.lastSeen = Date.now();
                return res.json({ success: true, student: row, sessionToken: existingSession.token });
            } else {
                // SECOND DEVICE DETECTED! Block login and fire Red Alarm on Admin Dashboard
                sendAdminCheatAlert(row.full_name, "Student Portal Login", "Duplicate Device / Proxy Login Blocked");
                return res.json({
                    success: false,
                    message: "SECURITY LOCK: This Student ID is already active on another device! This duplicate login attempt has been reported to your instructor."
                });
            }
        }

        // LAYER 2: Check if Gatekeeper Room Lock is active for new logins
        if (isExamRoomLocked) {
            sendAdminCheatAlert(row.full_name, "Student Portal Login", "Late / Outside Login Blocked (Room Locked)");
            return res.json({
                success: false,
                message: "EXAM ENTRY CLOSED: The instructor has locked the exam room. No new outside connections are permitted."
            });
        }

        // Issue a new Single-Device Token for this student
        const newToken = crypto.randomBytes(16).toString('hex');
        activeStudentSessions.set(cleanId, {
            token: newToken,
            studentName: row.full_name,
            time: Date.now(),
            lastSeen: Date.now()
        });
        broadcastSecurityState();

        res.json({ success: true, student: row, sessionToken: newToken });
    });
});

// Session lease: the student portal pings every 15s. A crashed/closed browser stops
// pinging, and the sweeper above releases the device lock so a reconnecting student
// (or their replacement seat) is not blocked by a zombie session.
const touchStudentSession = (studentId, clientToken) => {
    const cleanId = String(studentId || '').trim();
    const session = activeStudentSessions.get(cleanId);
    if (!session || !clientToken || session.token !== clientToken) return false;
    session.lastSeen = Date.now();
    return true;
};

expressApp.post('/api/student-heartbeat', (req, res) => {
    const { studentId, clientToken } = req.body || {};
    if (!touchStudentSession(studentId, clientToken)) {
        return res.json({ success: false, message: 'Session expired or invalid.' });
    }
    res.json({ success: true });
});

// Cooperative logout / unload signal. Only releases the lock when the token matches,
// so a stale tab cannot kick the student who is actively holding the session.
expressApp.post('/api/student-logout', (req, res) => {
    const { studentId, clientToken } = req.body || {};
    const cleanId = String(studentId || '').trim();
    const session = activeStudentSessions.get(cleanId);
    if (session && clientToken && session.token === clientToken) {
        activeStudentSessions.delete(cleanId);
        broadcastSecurityState();
    }
    res.json({ success: true });
});

// Layer 3: Whiteboard PIN Verification (Single-Use per Student ID & Bound Device)
expressApp.post('/api/verify-quiz-pin', (req, res) => {
    const { studentId, studentName, quizTitle, pin, clientToken } = req.body;
    const cleanId = (studentId || '').trim();
    const cleanPin = (pin || '').trim();

    // Verify Layer 1 Token first
    const session = activeStudentSessions.get(cleanId);
    if (!session || session.token !== clientToken) {
        sendAdminCheatAlert(studentName || cleanId, quizTitle || "Exam", "Unauthorized Token Mismatch");
        return res.json({
            success: false,
            message: "SESSION INVALID: Your device token does not match the active session. Please ask your instructor to reset your device lock."
        });
    }

    const redemptionKey = `${cleanId}___${quizTitle}`;

    // Check if this Student ID already redeemed a PIN for this quiz
    if (redeemedStudentPins.has(redemptionKey)) {
        const boundToken = redeemedStudentPins.get(redemptionKey);
        if (boundToken === clientToken) {
            // Same student on their own bound device re-entering after an accidental abort
            return res.json({ success: true });
        }
        sendAdminCheatAlert(studentName || cleanId, quizTitle, "Multiple PIN Redemption Attempt Blocked");
        return res.json({
            success: false,
            message: "PIN ALREADY USED: This Student ID has already unlocked this exam on another session."
        });
    }

    db.get("SELECT passcode FROM quizzes WHERE title = ?", [quizTitle], (err, row) => {
        const quizStaticPasscode = (row && row.passcode) ? row.passcode.trim() : "";

        // Accept EITHER the live Dashboard PIN on the whiteboard OR the quiz's specific passcode
        const isMatch = (cleanPin === dynamicRoomPin) || (quizStaticPasscode !== "" && cleanPin === quizStaticPasscode);

        if (!isMatch) {
            return res.json({
                success: false,
                message: "Incorrect PIN code. Check the 4-digit code written on the whiteboard."
            });
        }

        // Bind the single-use ticket to this Student ID + Device Token
        redeemedStudentPins.set(redemptionKey, clientToken);
        unlockedStudentIds.add(cleanId);

        // Check if all expected students have now unlocked the exam to trigger Auto-Lock
        checkAutoGatekeeperLock();
        broadcastSecurityState();

        res.json({ success: true });
    });
});

// Helper: Format quizzes for Student Portal so it only shows the teacher's target item count
function formatQuizzesForStudent(rows) {
    return (rows || []).map(q => {
        const targetLimit = (q.items && q.items > 0) ? q.items : q.uploaded_count;
        const visibleItems = q.uploaded_count > 0 ? Math.min(targetLimit, q.uploaded_count) : 0;
        return { ...q, items: visibleItems, uploaded_count: visibleItems };
    });
}

// Helper: Shuffle full question pool, slice to target items, and randomize MCQ choices (A, B, C, D)
function getRandomizedQuizQuestions(quizTitle, callback) {
    db.get("SELECT items FROM quizzes WHERE title = ?", [quizTitle], (err, quizRow) => {
        db.all("SELECT * FROM questions WHERE quiz_title = ?", [quizTitle], (err2, questionRows) => {
            let pool = questionRows ? [...questionRows] : [];

            // 1. Fisher-Yates Shuffle across the entire question bank pool
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }

            // 2. Slice the pool down to the exact number of items set by the teacher
            const drawLimit = (quizRow && quizRow.items > 0)
                ? Math.min(quizRow.items, pool.length)
                : pool.length;

            // 3. Shuffle A, B, C, D options for each Multiple Choice question
            const selectedQuestions = pool.slice(0, drawLimit).map(q => {
                const qType = (q.question_type || 'mcq').toLowerCase();
                if (qType !== 'mcq') return q;

                const letters = ['A', 'B', 'C', 'D'];
                const currentCorrect = (q.correct_answer || 'A').toUpperCase().trim();

                const choices = [
                    { origKey: 'A', text: q.option_a },
                    { origKey: 'B', text: q.option_b },
                    { origKey: 'C', text: q.option_c },
                    { origKey: 'D', text: q.option_d }
                ].filter(c => c.text !== null && c.text !== undefined && String(c.text).trim() !== '');

                if (choices.length < 2) return q;

                for (let i = choices.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [choices[i], choices[j]] = [choices[j], choices[i]];
                }

                let newCorrect = currentCorrect;
                choices.forEach((choice, idx) => {
                    if (choice.origKey === currentCorrect) {
                        newCorrect = letters[idx];
                    }
                });

                return {
                    ...q,
                    option_a: choices[0] ? choices[0].text : '',
                    option_b: choices[1] ? choices[1].text : '',
                    option_c: choices[2] ? choices[2].text : '',
                    option_d: choices[3] ? choices[3].text : '',
                    correct_answer: newCorrect
                };
            });

            callback(selectedQuestions);
        });
    });
}

expressApp.get('/api/quizzes', (req, res) => {
    const studentId = String(req.query.studentId || '').trim();

    // Backward-compatible: no student ID means the admin/legacy list.
    if (!studentId) {
        db.all(activeQuizWithInstructorQuery, [], (err, rows) => {
            res.json(formatQuizzesForStudent(rows));
        });
        return;
    }

    // v2.1.4 Smart Exam Filtering: only return quizzes this Student ID can see.
    getVisibleQuizzesForStudent(studentId, (rows) => {
        res.json(formatQuizzesForStudent(rows));
    });
});

expressApp.get('/api/questions', (req, res) => {
    const title = req.query.title;
    getRandomizedQuizQuestions(title, (selectedQuestions) => {
        res.json(selectedQuestions);
    });
});

expressApp.get('/api/student-results', (req, res) => {
    const studentId = req.query.studentId;
    db.all("SELECT quiz_title FROM results WHERE student_id = ?", [studentId], (err, rows) => { res.json(rows || []); });
});

expressApp.post('/api/submit-result', (req, res) => {
    const data = req.body;
    db.get("SELECT * FROM quizzes WHERE title = ?", [data.quiz_title], (err, row) => {
        if (!row) return res.json({ success: false, message: "Error: This quiz was deleted." });
        const answersStr = data.student_answers ? JSON.stringify(data.student_answers) : null;
        db.run("INSERT INTO results (student_name, student_id, quiz_title, score, total_items, status, date_completed, student_answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [data.student_name, data.student_id, data.quiz_title, data.score, data.total_items, data.status, data.date_completed, answersStr], function(err) {
            if (!err) recordAttendance(data);
            const adminWindow = BrowserWindow.getAllWindows()[0];
            if (adminWindow) {
                db.all(resultsWithSectionQuery, [], (err2, rows) => { adminWindow.webContents.send('load-results', rows || []); });
            }
            res.json({ success: true });
        });
    });
});

// Silent background incident counter. Returns the running tally so the student
// portal can mirror it locally; it deliberately never submits the exam.
expressApp.post('/api/log-incident', (req, res) => {
    const payload = req.body || {};
    const studentId = String(payload.student_id || '').trim();
    const quizTitle = String(payload.quiz_title || '').trim();
    const studentName = String(payload.student_name || '').trim();
    const reason = String(payload.reason || 'Security Violation').trim();

    if (!studentId || !quizTitle) {
        return res.json({ success: false, incident_count: 0 });
    }

    const updated = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

    db.run(`INSERT INTO exam_incidents (student_id, quiz_title, student_name, incident_count, last_reason, last_updated)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(student_id, quiz_title) DO UPDATE SET
                incident_count = exam_incidents.incident_count + 1,
                student_name = excluded.student_name,
                last_reason = excluded.last_reason,
                last_updated = excluded.last_updated`,
        [studentId, quizTitle, studentName, reason, updated], (err) => {
            if (err) {
                console.error('Could not record exam incident:', err.message || err);
                return res.json({ success: false, incident_count: 0 });
            }

            db.get("SELECT incident_count FROM exam_incidents WHERE student_id = ? AND quiz_title = ?", [studentId, quizTitle], (readErr, row) => {
                const incidentCount = (row && row.incident_count) || 0;

                const adminWindow = BrowserWindow.getAllWindows()[0];
                if (adminWindow) {
                    adminWindow.webContents.send('trigger-cheat-alarm', {
                        student_name: studentName || studentId,
                        quiz_title: quizTitle,
                        time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }),
                        reason: reason,
                        incident_count: incidentCount
                    });
                    // Refresh the teacher tables so the warning badge updates live.
                    db.all(resultsWithSectionQuery, [], (err2, rows) => {
                        if (!err2) adminWindow.webContents.send('load-results', rows || []);
                    });
                    broadcastAttendance();
                }

                res.json({ success: true, incident_count: incidentCount });
            });
        });
});

expressApp.post('/api/cheat-alert', (req, res) => {
    const { student_name, quiz_title, time, reason } = req.body;
    const adminWindow = BrowserWindow.getAllWindows()[0];
    if (adminWindow) {
        adminWindow.webContents.send('trigger-cheat-alarm', {
            student_name,
            quiz_title,
            time,
            reason: reason || 'Tab Switch / Left Exam'
        });
    }
    res.json({ success: true });
});

expressApp.use(express.static(__dirname)); 
expressApp.listen(PORT, () => {
    console.log(`\n📡 LOCAL SERVER RUNNING on Port ${PORT}\n`);
});

const dbPath = (() => {
    if (!app.isPackaged) return path.join(__dirname, 'database.sqlite');

    // Store the live database in AppData so app updates never overwrite instructor data
    const userDataDir = app.getPath('userData');
    const persistentDbPath = path.join(userDataDir, 'database.sqlite');
    const bundledDbPath = path.join(process.resourcesPath, 'database.sqlite');

    if (!fs.existsSync(persistentDbPath)) {
        try {
            fs.mkdirSync(userDataDir, { recursive: true });
            if (fs.existsSync(bundledDbPath)) {
                fs.copyFileSync(bundledDbPath, persistentDbPath);
            }
        } catch (err) {
            console.error("Database initialization error:", err);
            return bundledDbPath;
        }
    }
    return persistentDbPath;
})();

const db = new sqlite3.Database(dbPath);

// Batch 1: Older databases created attendance with UNIQUE(quiz_title, student_id)
// and no subject column. Rebuild that table once so attendance is isolated by
// subject + quiz. Quizzes are matched by title because the rest of the schema
// (questions/results/roster) is title-keyed.
function migrateAttendanceScoping() {
    db.all("PRAGMA table_info(attendance)", [], (err, columns) => {
        if (err || !columns || columns.length === 0) return;

        const hasSubject = columns.some(col => String(col.name || '').toLowerCase() === 'subject');
        const ensureIndexes = () => {
            db.run("CREATE INDEX IF NOT EXISTS idx_attendance_quiz ON attendance(quiz_title)");
            db.run("CREATE INDEX IF NOT EXISTS idx_attendance_subject ON attendance(subject)");
            db.run("CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id)");
        };

        if (hasSubject) {
            // Recover from an interrupted previous migration, if one left data in
            // the legacy table. The INSERT is a no-op when the table is absent.
            db.run(`INSERT OR IGNORE INTO attendance (quiz_title, subject, student_id, student_name, course_section, date_recorded, status)
                    SELECT legacy.quiz_title,
                           IFNULL((SELECT quizzes.subject FROM quizzes WHERE quizzes.title = legacy.quiz_title LIMIT 1), ''),
                           legacy.student_id, legacy.student_name, legacy.course_section, legacy.date_recorded,
                           IFNULL(legacy.status, 'Present')
                    FROM attendance_legacy_scope AS legacy`, [], (recoverErr) => {
                if (!recoverErr) db.run("DROP TABLE IF EXISTS attendance_legacy_scope");
            });
            ensureIndexes();
            return;
        }

        db.run("DROP TABLE IF EXISTS attendance_legacy_scope");
        db.run("ALTER TABLE attendance RENAME TO attendance_legacy_scope");
        db.run(`CREATE TABLE attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_title TEXT, subject TEXT, student_id TEXT, student_name TEXT, course_section TEXT, date_recorded TEXT, status TEXT DEFAULT 'Present', UNIQUE(subject, quiz_title, student_id))`);
        db.run(`INSERT OR IGNORE INTO attendance (quiz_title, subject, student_id, student_name, course_section, date_recorded, status)
                SELECT legacy.quiz_title,
                       IFNULL((SELECT quizzes.subject FROM quizzes WHERE quizzes.title = legacy.quiz_title LIMIT 1), ''),
                       legacy.student_id, legacy.student_name, legacy.course_section, legacy.date_recorded,
                       IFNULL(legacy.status, 'Present')
                FROM attendance_legacy_scope AS legacy`);
        db.run("DROP TABLE attendance_legacy_scope");
        ensureIndexes();
    });
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT UNIQUE, full_name TEXT, course_section TEXT, date_registered TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_name TEXT UNIQUE, instructor_name TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, subject TEXT, items INTEGER, time_limit INTEGER, date_created TEXT, passcode TEXT, tab_limit INTEGER, passing_rate INTEGER, idle_time_limit INTEGER DEFAULT 0, question_time_limit INTEGER DEFAULT 0, require_camera INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, target_section TEXT DEFAULT 'All Sections', custom_instructions TEXT)`);
    
    db.run(`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_title TEXT, question_text TEXT, option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT, correct_answer TEXT, question_type TEXT DEFAULT 'mcq', extended_data TEXT)`);
    
    db.run(`CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, student_name TEXT, student_id TEXT, quiz_title TEXT, score INTEGER, total_items INTEGER, status TEXT, date_completed TEXT, student_answers TEXT)`);

    // v2.1.4: incident tally per student exam session (student + quiz).
    // Warnings never submit the exam; they only increment this counter.
    db.run(`CREATE TABLE IF NOT EXISTS exam_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL, quiz_title TEXT NOT NULL, student_name TEXT, incident_count INTEGER DEFAULT 0, last_reason TEXT, last_updated TEXT, UNIQUE(student_id, quiz_title))`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_exam_incidents_session ON exam_incidents(student_id, quiz_title)`);

    // v2.1.4: lightweight roster mapping for Smart Exam Filtering.
    db.run(`CREATE TABLE IF NOT EXISTS student_roster (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL, quiz_title TEXT NOT NULL, assigned_by TEXT, date_assigned TEXT, UNIQUE(student_id, quiz_title))`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_student_roster_student ON student_roster(student_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_student_roster_quiz ON student_roster(quiz_title)`);

    // Batch 1: Attendance is scoped by subject + quiz + student so the same
    // student's status in one quiz can never bleed into another quiz.
    db.run(`CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_title TEXT, subject TEXT, student_id TEXT, student_name TEXT, course_section TEXT, date_recorded TEXT, status TEXT DEFAULT 'Present', UNIQUE(subject, quiz_title, student_id))`);
    migrateAttendanceScoping();

    db.run(`ALTER TABLE quizzes ADD COLUMN passcode TEXT`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN tab_limit INTEGER`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN passing_rate INTEGER`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN idle_time_limit INTEGER DEFAULT 0`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN question_time_limit INTEGER DEFAULT 0`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN require_camera INTEGER DEFAULT 0`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN is_archived INTEGER DEFAULT 0`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN target_section TEXT DEFAULT 'All Sections'`, function(err) {});
    db.run(`ALTER TABLE quizzes ADD COLUMN custom_instructions TEXT`, function(err) {});
    db.run(`ALTER TABLE results ADD COLUMN student_answers TEXT`, function(err) {});
    
    db.run(`ALTER TABLE questions ADD COLUMN question_type TEXT DEFAULT 'mcq'`, function(err) {});
    db.run(`ALTER TABLE questions ADD COLUMN extended_data TEXT`, function(err) {});

    // v2.1.4 Instructor Accounts & Student Ownership (non-destructive migrations)
    db.run(`ALTER TABLE admins ADD COLUMN display_name TEXT`, function(err) {});
    db.run(`ALTER TABLE students ADD COLUMN registered_by TEXT`, function(err) {});
    db.run(`UPDATE admins SET display_name = username WHERE display_name IS NULL OR TRIM(display_name) = ''`);
    db.run(`UPDATE admins SET display_name = 'Administrator' WHERE id = 1 AND (display_name IS NULL OR TRIM(display_name) = '' OR display_name = 'admin')`);

    db.get("SELECT * FROM admins WHERE username = 'admin'", [], (err, row) => {
        if (!row) db.run("INSERT INTO admins (username, password, display_name) VALUES ('admin', 'admin', 'Administrator')");
    });
    db.run(`DELETE FROM questions WHERE quiz_title NOT IN (SELECT title FROM quizzes)`);
    rebuildAllRosters();
});

// ============================================================================
// BATCH 1: AUTOMATED ATTENDANCE (SUBJECT + QUIZ SCOPED)
// ============================================================================
const attendanceSelect = `SELECT attendance.*,
    IFNULL(NULLIF(TRIM(attendance.course_section), ''), 'Unknown') AS course_section,
    IFNULL(NULLIF(TRIM(attendance.subject), ''),
        IFNULL((SELECT quizzes.subject FROM quizzes WHERE quizzes.title = attendance.quiz_title LIMIT 1), '')) AS subject,
    IFNULL(subjects.instructor_name, '') AS instructor_name,
    IFNULL((SELECT exam_incidents.incident_count FROM exam_incidents WHERE exam_incidents.student_id = attendance.student_id AND exam_incidents.quiz_title = attendance.quiz_title LIMIT 1), 0) AS incident_count
    FROM attendance
    LEFT JOIN subjects ON subjects.subject_name = IFNULL(NULLIF(TRIM(attendance.subject), ''),
        (SELECT quizzes.subject FROM quizzes WHERE quizzes.title = attendance.quiz_title LIMIT 1))`;

const attendanceQuery = `${attendanceSelect} ORDER BY attendance.id DESC`;

// Builds a SQL-side scope so attendance reads (not just the UI) stay isolated.
function buildAttendanceQuery(filters) {
    const payload = (filters && typeof filters === 'object') ? filters : {};
    const quizTitle = String(payload.quizTitle || '').trim();
    const subject = String(payload.subject || '').trim();
    const instructor = String(payload.instructor || '').trim();
    const studentId = String(payload.studentId || '').trim();
    const where = [];
    const params = [];

    if (quizTitle && quizTitle !== 'all') {
        where.push("attendance.quiz_title = ?");
        params.push(quizTitle);
    }

    if (subject && subject !== 'all') {
        where.push("IFNULL(NULLIF(TRIM(attendance.subject), ''), (SELECT quizzes.subject FROM quizzes WHERE quizzes.title = attendance.quiz_title LIMIT 1)) = ?");
        params.push(subject);
    }

    if (instructor && instructor !== 'all') {
        where.push(`EXISTS (
            SELECT 1 FROM subjects AS scope_subjects
            WHERE LOWER(TRIM(scope_subjects.instructor_name)) = LOWER(TRIM(?))
              AND scope_subjects.subject_name = IFNULL(NULLIF(TRIM(attendance.subject), ''),
                  (SELECT quizzes.subject FROM quizzes WHERE quizzes.title = attendance.quiz_title LIMIT 1))
        )`);
        params.push(instructor);
    }

    if (studentId) {
        where.push("attendance.student_id = ?");
        params.push(studentId);
    }

    const sql = attendanceSelect +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY attendance.id DESC';
    return { sql, params };
}

function getAttendanceRows(filters, callback) {
    const { sql, params } = buildAttendanceQuery(filters);
    db.all(sql, params, (err, rows) => callback(err, rows || []));
}

function broadcastAttendance() {
    const adminWindow = BrowserWindow.getAllWindows()[0];
    if (!adminWindow) return;
    db.all(attendanceQuery, [], (err, rows) => {
        if (!err) adminWindow.webContents.send('load-attendance', rows || []);
    });
}

// Every successful quiz submission marks that student present for that quiz only.
// Resubmissions refresh the timestamp/name but never overwrite a manual
// Absent/Late status, and a student's status in Quiz A never touches Quiz B.
function recordAttendance(data, callback) {
    const payload = data || {};
    const studentId = String(payload.student_id || '').trim();
    const requestedTitle = String(payload.quiz_title || '').trim();
    const finish = () => { if (typeof callback === 'function') callback(); };
    if (!studentId || !requestedTitle) return finish();

    db.get("SELECT title, subject FROM quizzes WHERE title = ? LIMIT 1", [requestedTitle], (quizErr, quiz) => {
        const quizTitle = String((quiz && quiz.title) || requestedTitle).trim();
        const subject = String((quiz && quiz.subject) || payload.subject || '').trim();

        db.get("SELECT full_name, course_section FROM students WHERE student_id = ?", [studentId], (err, student) => {
            const studentName = String(payload.student_name || (student && student.full_name) || '').trim();
            const section = String(payload.course_section || (student && student.course_section) || 'Unknown').trim() || 'Unknown';
            const recorded = String(payload.date_completed || '').trim() ||
                new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
            const values = [quizTitle, subject, studentId, studentName, section, recorded];

            const handleResult = (err2) => {
                if (err2) {
                    // Extremely old schema fallback: keep the row usable even if the
                    // subject-scoped conflict target is unavailable.
                    db.run("INSERT OR REPLACE INTO attendance (quiz_title, subject, student_id, student_name, course_section, date_recorded, status) VALUES (?, ?, ?, ?, ?, ?, 'Present')",
                        [...values], (err3) => {
                            if (!err3) broadcastAttendance();
                            finish();
                        });
                    return;
                }
                broadcastAttendance();
                finish();
            };

            db.run(`INSERT INTO attendance (quiz_title, subject, student_id, student_name, course_section, date_recorded, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'Present')
                    ON CONFLICT(subject, quiz_title, student_id) DO UPDATE SET
                        student_name = excluded.student_name,
                        course_section = excluded.course_section,
                        date_recorded = excluded.date_recorded`,
                values, handleResult);
        });
    });
}

// ============================================================================
// BATCH 3: PDF REPORT EXPORT (renders HTML in a hidden window via printToPDF)
// ============================================================================
function escapePdfHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildPdfReportHtml(options) {
    const headers = options.headers || [];
    const rows = options.rows || [];
    const rowsHtml = rows.map(cells =>
        `<tr>${cells.map(cell => `<td>${escapePdfHtml(cell)}</td>`).join('')}</tr>`
    ).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; }
    .brand { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #555; }
    h1 { font-size: 20px; margin: 4px 0 2px; }
    .subtitle { font-size: 11px; color: #444; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    th { background: #1e293b; color: #fff; text-align: left; padding: 6px 7px; }
    td { padding: 5px 7px; border-bottom: 1px solid #d8dee7; }
    tr:nth-child(even) td { background: #f5f7fa; }
    .meta { margin-top: 10px; font-size: 9px; color: #666; }
</style></head><body>
    <div class="brand">Offline Exam System</div>
    <h1>${escapePdfHtml(options.title)}</h1>
    <p class="subtitle">${escapePdfHtml(options.subtitle || '')}</p>
    <table><thead><tr>${headers.map(h => `<th>${escapePdfHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml}</tbody></table>
    <p class="meta">${escapePdfHtml(options.meta || '')}</p>
</body></html>`;
}

function exportPdfReport(event, options) {
    const rows = options.rows || [];
    if (rows.length === 0) {
        event.reply('file-status', { success: false, message: options.emptyMessage || 'No records match your current filter selection.' });
        return;
    }

    const html = buildPdfReportHtml(options);
    const tempFile = path.join(os.tmpdir(), `exam-report-${Date.now()}-${Math.floor(Math.random() * 100000)}.html`);
    const cleanup = () => { fs.unlink(tempFile, () => {}); };

    fs.writeFile(tempFile, html, 'utf8', (writeErr) => {
        if (writeErr) {
            cleanup();
            event.reply('file-status', { success: false, message: 'Could not prepare the PDF report.' });
            return;
        }

        const reportWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
        const closeReportWindow = () => { try { reportWindow.destroy(); } catch (err) {} };
        const fail = (message) => {
            closeReportWindow();
            cleanup();
            event.reply('file-status', { success: false, message: message });
        };

        reportWindow.loadFile(tempFile).then(() => {
            return reportWindow.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4',
                landscape: true,
                margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
                displayHeaderFooter: true,
                headerTemplate: '<div></div>',
                footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#666;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'
            });
        }).then(pdfData => {
            return dialog.showSaveDialog({
                title: options.dialogTitle || 'Save PDF Report',
                defaultPath: path.join(app.getPath('documents'), options.defaultName || 'Report.pdf'),
                filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
            }).then(result => ({ pdfData, result }));
        }).then(({ pdfData, result }) => {
            if (result.canceled || !result.filePath) {
                closeReportWindow();
                cleanup();
                return;
            }

            fs.writeFile(result.filePath, pdfData, (saveErr) => {
                closeReportWindow();
                cleanup();
                event.reply('file-status', saveErr
                    ? { success: false, message: 'Could not save the PDF report.' }
                    : { success: true, message: `Success! Saved ${rows.length} records to PDF.` });
            });
        }).catch(() => fail('Could not generate the PDF report.'));
    });
}

function getScopedQuizTitlesForInstructor(instructor, callback) {
    if (!instructor || instructor === 'all') return callback(null);
    db.all("SELECT title FROM quizzes WHERE subject IN (SELECT subject_name FROM subjects WHERE LOWER(TRIM(instructor_name)) = LOWER(TRIM(?)))", [instructor], (err, rows) => {
        callback(new Set((rows || []).map(row => row.title)));
    });
}

function createWindow () {
    const win = new BrowserWindow({
        width: 1280, height: 800, icon: 'Logo.ico', show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile('index.html');
    win.once('ready-to-show', () => { win.show(); win.setAlwaysOnTop(true); win.focus(); win.setAlwaysOnTop(false); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.on('get-server-ip', (event) => {
    const interfaces = os.networkInterfaces();
    let serverIp = 'localhost';
    for (let devName in interfaces) {
        let iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            let alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) serverIp = alias.address;
        }
    }
    event.reply('server-ip-response', serverIp);
});

// ============================================================================
// ACCOUNTS & INSTRUCTOR ACCESS CONTROL
// ============================================================================
function normalizeProfileName(name) {
    return String(name === null || name === undefined ? '' : name).trim();
}

function isMasterAdminRow(row) {
    return !!row && (row.id === 1 || String(row.username || '').toLowerCase() === 'admin');
}

function isMasterAdminId(userId, callback) {
    if (userId === undefined || userId === null || userId === '') return callback(false);
    db.get("SELECT id, username FROM admins WHERE id = ?", [userId], (err, row) => callback(isMasterAdminRow(row)));
}

function replyAdmins(event) {
    db.all("SELECT id, username, password, display_name FROM admins ORDER BY id ASC", [], (err, rows) => {
        event.reply('load-admins', rows || []);
    });
}

ipcMain.on('login-request', (event, credentials) => {
    db.get("SELECT * FROM admins WHERE username = ? AND password = ?", [credentials.username, credentials.password], (err, row) => {
        if (!row) return event.reply('login-response', { success: false });
        event.reply('login-response', {
            success: true,
            user: {
                id: row.id,
                username: row.username,
                displayName: normalizeProfileName(row.display_name) || row.username,
                isAdmin: isMasterAdminRow(row)
            }
        });
    });
});
ipcMain.on('student-login-request', (event, studentId) => { db.get("SELECT * FROM students WHERE student_id = ?", [studentId], (err, row) => { event.reply('student-login-response', row ? { success: true, student: row } : { success: false }); }); });

// Safe profile list: instructor names from Subject records plus registered instructor accounts.
ipcMain.on('get-instructor-profiles', (event) => {
    db.all("SELECT subject_name, instructor_name FROM subjects", [], (err, subjectRows) => {
        db.all("SELECT id, username, display_name FROM admins ORDER BY id ASC", [], (err2, adminRows) => {
            const names = new Set();
            (subjectRows || []).forEach(r => {
                const n = normalizeProfileName(r.instructor_name);
                if (n) names.add(n);
            });
            (adminRows || []).forEach(r => {
                if (isMasterAdminRow(r)) return;
                const n = normalizeProfileName(r.display_name) || normalizeProfileName(r.username);
                if (n) names.add(n);
            });
            const accounts = (adminRows || []).filter(r => !isMasterAdminRow(r)).map(r => ({
                id: r.id,
                username: r.username,
                displayName: normalizeProfileName(r.display_name) || r.username
            }));
            event.reply('load-instructor-profiles', {
                names: [...names].sort((a, b) => a.localeCompare(b)),
                accounts
            });
        });
    });
});

// Unlock another instructor's data with that instructor's account password.
// The master administrator password always works as an override.
ipcMain.on('verify-instructor-access', (event, data) => {
    const target = normalizeProfileName(data && data.target);
    const password = String((data && data.password) || '');
    const fail = (message) => event.reply('verify-instructor-access-response', { success: false, message });

    if (!target) return fail('No instructor profile was selected.');
    if (!password) return fail('Please enter a password.');

    db.all("SELECT id, username, password, display_name FROM admins", [], (err, rows) => {
        const admins = rows || [];
        const master = admins.find(isMasterAdminRow);

        if (master && String(master.password) === password) {
            return event.reply('verify-instructor-access-response', { success: true });
        }

        if (target === 'all') {
            return fail('Master View requires the administrator password.');
        }

        const key = target.toLowerCase();
        const account = admins.find(a => !isMasterAdminRow(a) && (
            normalizeProfileName(a.display_name).toLowerCase() === key ||
            normalizeProfileName(a.username).toLowerCase() === key
        ));

        if (!account) return fail(`"${target}" has no registered account yet. Ask the administrator to create one.`);
        if (String(account.password) === password) {
            return event.reply('verify-instructor-access-response', { success: true });
        }
        return fail('Incorrect password for this instructor profile.');
    });
});

// Any signed-in account can rotate its own password by confirming the old one.
ipcMain.on('change-password', (event, data) => {
    const userId = data && data.userId;
    const oldPassword = String((data && data.oldPassword) || '');
    const newPassword = String((data && data.newPassword) || '');

    if (!userId) return event.reply('password-change-response', { success: false, message: 'You must be signed in to change your password.' });
    if (newPassword.length < 3) return event.reply('password-change-response', { success: false, message: 'The new password must be at least 3 characters long.' });

    db.get("SELECT * FROM admins WHERE id = ?", [userId], (err, row) => {
        if (!row) return event.reply('password-change-response', { success: false, message: 'Account not found.' });
        if (String(row.password) !== oldPassword) {
            return event.reply('password-change-response', { success: false, message: 'Your current password is incorrect.' });
        }
        db.run("UPDATE admins SET password = ? WHERE id = ?", [newPassword, userId], (err2) => {
            if (err2) return event.reply('password-change-response', { success: false, message: 'Could not update the password.' });
            event.reply('password-change-response', { success: true, message: 'Password updated successfully.' });
        });
    });
});

// The administrator can reset any instructor password without the old one.
ipcMain.on('admin-change-password', (event, data) => {
    const payload = data || {};
    isMasterAdminId(payload.requesterId, (ok) => {
        if (!ok) return event.reply('admin-password-response', { success: false, message: 'Only the master administrator can change instructor passwords.' });
        if (!payload.targetId) return event.reply('admin-password-response', { success: false, message: 'No account selected.' });
        const newPassword = String(payload.newPassword || '');
        if (newPassword.length < 3) return event.reply('admin-password-response', { success: false, message: 'The new password must be at least 3 characters long.' });
        db.run("UPDATE admins SET password = ? WHERE id = ?", [newPassword, payload.targetId], (err) => {
            if (err) return event.reply('admin-password-response', { success: false, message: 'Could not update the password.' });
            event.reply('admin-password-response', { success: true, message: 'Instructor password updated successfully.' });
            replyAdmins(event);
        });
    });
});

function emptyDashboardStats() {
    return { students: 0, quizzes: 0, questions: 0, results: 0, recentQuizzes: [], topStudents: [], recentActivity: [], passed: 0, failed: 0, atRisk: null };
}

ipcMain.on('get-dashboard-stats', (event, instructorName) => {
    const instructor = (instructorName && instructorName !== 'all') ? String(instructorName).trim() : '';

    // MASTER VIEW: unscoped totals across the whole database
    if (!instructor) {
        let stats = emptyDashboardStats();
        db.serialize(() => {
            db.get("SELECT COUNT(*) AS count FROM students", (err, row) => { if(row) stats.students = row.count; });
            db.get("SELECT COUNT(*) AS count FROM quizzes WHERE IFNULL(is_archived, 0) = 0", (err, row) => { if(row) stats.quizzes = row.count; });
            db.get("SELECT COUNT(*) AS count FROM questions", (err, row) => { if(row) stats.questions = row.count; });
            db.get("SELECT COUNT(*) AS count FROM results", (err, row) => { if(row) stats.results = row.count; });
            db.get("SELECT COUNT(*) AS count FROM results WHERE status = 'Passed'", (err, row) => { if(row) stats.passed = row.count; });
            db.get("SELECT COUNT(*) AS count FROM results WHERE status = 'Failed'", (err, row) => { if(row) stats.failed = row.count; });
            
            db.get("SELECT quiz_title, COUNT(*) as total_takes, SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) as fails FROM results GROUP BY quiz_title ORDER BY (CAST(SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*)) DESC LIMIT 1", (err, row) => {
                if (row && row.fails > 0) stats.atRisk = { title: row.quiz_title, failRate: Math.round((row.fails / row.total_takes) * 100) };
            });

            const recentQuizQueryWithCount = "SELECT quizzes.*, (SELECT COUNT(*) FROM questions WHERE questions.quiz_title = quizzes.title) AS uploaded_count FROM quizzes WHERE IFNULL(is_archived, 0) = 0 ORDER BY id DESC LIMIT 4";
            db.all(recentQuizQueryWithCount, (err, qRows) => { if(qRows) stats.recentQuizzes = qRows; });
            db.all("SELECT student_name, student_id, ((score * 100.0) / total_items) AS percentage FROM results ORDER BY percentage DESC LIMIT 4", (err, sRows) => { if(sRows) stats.topStudents = sRows; });
            db.all("SELECT student_name, quiz_title, score, date_completed FROM results ORDER BY id DESC LIMIT 4", (err, aRows) => { if(aRows) stats.recentActivity = aRows; event.reply('load-dashboard-stats', stats); });
        });
        return;
    }

    // INSTRUCTOR VIEW: only counts/totals for quizzes belonging to the instructor's subjects
    db.all("SELECT title FROM quizzes WHERE subject IN (SELECT subject_name FROM subjects WHERE LOWER(TRIM(instructor_name)) = LOWER(TRIM(?)))", [instructor], (err, rows) => {
        const titles = (rows || []).map(r => r.title);
        if (titles.length === 0) {
            const stats = emptyDashboardStats();
            db.get(`SELECT COUNT(*) AS count FROM students WHERE LOWER(IFNULL(registered_by, '')) = LOWER(?)`, [instructor], (e, row) => {
                if (row) stats.students = row.count;
                event.reply('load-dashboard-stats', stats);
            });
            return;
        }

        const marks = titles.map(() => '?').join(',');
        const stats = emptyDashboardStats();
        let pending = 10;
        const finish = () => { pending -= 1; if (pending === 0) event.reply('load-dashboard-stats', stats); };

        db.get(`SELECT COUNT(*) AS count FROM students WHERE LOWER(IFNULL(registered_by, '')) = LOWER(?)`, [instructor], (e, row) => { if (row) stats.students = row.count; finish(); });
        db.get(`SELECT COUNT(*) AS count FROM quizzes WHERE IFNULL(is_archived, 0) = 0 AND title IN (${marks})`, titles, (e, row) => { if (row) stats.quizzes = row.count; finish(); });
        db.get(`SELECT COUNT(*) AS count FROM questions WHERE quiz_title IN (${marks})`, titles, (e, row) => { if (row) stats.questions = row.count; finish(); });
        db.get(`SELECT COUNT(*) AS count FROM results WHERE quiz_title IN (${marks})`, titles, (e, row) => { if (row) stats.results = row.count; finish(); });
        db.get(`SELECT COUNT(*) AS count FROM results WHERE status = 'Passed' AND quiz_title IN (${marks})`, titles, (e, row) => { if (row) stats.passed = row.count; finish(); });
        db.get(`SELECT COUNT(*) AS count FROM results WHERE status = 'Failed' AND quiz_title IN (${marks})`, titles, (e, row) => { if (row) stats.failed = row.count; finish(); });

        db.get(`SELECT quiz_title, COUNT(*) as total_takes, SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) as fails FROM results WHERE quiz_title IN (${marks}) GROUP BY quiz_title ORDER BY (CAST(SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*)) DESC LIMIT 1`, titles, (e, row) => {
            if (row && row.fails > 0) stats.atRisk = { title: row.quiz_title, failRate: Math.round((row.fails / row.total_takes) * 100) };
            finish();
        });

        db.all(`SELECT quizzes.*, (SELECT COUNT(*) FROM questions WHERE questions.quiz_title = quizzes.title) AS uploaded_count FROM quizzes WHERE IFNULL(is_archived, 0) = 0 AND title IN (${marks}) ORDER BY id DESC LIMIT 4`, titles, (e, qRows) => { stats.recentQuizzes = qRows || []; finish(); });
        db.all(`SELECT student_name, student_id, ((score * 100.0) / total_items) AS percentage FROM results WHERE quiz_title IN (${marks}) ORDER BY percentage DESC LIMIT 4`, titles, (e, sRows) => { stats.topStudents = sRows || []; finish(); });
        db.all(`SELECT student_name, quiz_title, score, date_completed FROM results WHERE quiz_title IN (${marks}) ORDER BY id DESC LIMIT 4`, titles, (e, aRows) => { stats.recentActivity = aRows || []; finish(); });
    });
});

ipcMain.on('get-students', (event) => { db.all("SELECT * FROM students ORDER BY id DESC", [], (err, rows) => event.reply('load-students', rows || [])); });
ipcMain.on('add-student', (event, student) => { const registrar = normalizeProfileName(student.registered_by); db.run("INSERT INTO students (student_id, full_name, course_section, date_registered, registered_by) VALUES (?, ?, ?, ?, ?)", [student.student_id, student.full_name, student.course_section, student.date_registered, registrar], function(err) { if (err) { event.reply('student-add-response', { success: false, message: 'Error: ID registered!' }); } else { rebuildAllRosters(); db.all("SELECT * FROM students ORDER BY id DESC", [], (err2, rows) => { event.reply('load-students', rows || []); event.reply('student-add-response', { success: true }); }); } }); });
ipcMain.on('update-student', (event, student) => { const registrar = normalizeProfileName(student.registered_by); db.run("UPDATE students SET student_id = ?, full_name = ?, course_section = ?, registered_by = ? WHERE id = ?", [student.student_id, student.full_name, student.course_section, registrar, student.id], function(err) { if (err) { event.reply('student-update-response', { success: false, message: 'Error: ID exists!' }); } else { rebuildAllRosters(); db.all("SELECT * FROM students ORDER BY id DESC", [], (err2, rows) => { event.reply('load-students', rows || []); event.reply('student-update-response', { success: true }); }); } }); });
ipcMain.on('delete-student', (event, id) => { db.run("DELETE FROM students WHERE id = ?", [id], function(err) { rebuildAllRosters(); db.all("SELECT * FROM students ORDER BY id DESC", [], (err2, rows) => event.reply('load-students', rows || [])); }); });

ipcMain.on('import-students-csv', (event, payload) => { 
    const registrar = normalizeProfileName(payload && payload.registered_by);
    dialog.showOpenDialog({ 
        title: 'Import Students from Excel', 
        filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls', 'csv'] }], 
        properties: ['openFile'] 
    }).then(result => { 
        if (!result.canceled && result.filePaths.length > 0) { 
            try {
                const filePath = result.filePaths[0];
                const workbook = xlsx.readFile(filePath);
                let count = 0;
                const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                db.serialize(() => {
                    db.run("BEGIN TRANSACTION");

                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        const data = xlsx.utils.sheet_to_json(sheet, { defval: "" });

                        data.forEach(row => {
                            let studentId = "";
                            let fullName = "";
                            let course = "BSIT"; 

                            for (let key in row) {
                                const lowerKey = key.toLowerCase().replace(/[^a-z]/g, '');
                                if (lowerKey === 'studentno' || lowerKey === 'id' || lowerKey.includes('studentid')) {
                                    studentId = row[key];
                                } else if (lowerKey === 'name' || lowerKey === 'fullname') {
                                    fullName = row[key];
                                } else if (lowerKey === 'course' || lowerKey === 'program') {
                                    if(row[key]) course = row[key];
                                }
                            }

                            if (studentId && fullName) {
                                const cleanId = studentId.toString().replace(/\.0$/, '').trim();
                                const cleanName = fullName.toString().trim();
                                const subjectTag = sheetName.trim(); 
                                const cleanCourseSection = `${course} - ${subjectTag}`;

                                const stmt = `
                                    INSERT INTO students (student_id, full_name, course_section, date_registered, registered_by) 
                                    VALUES (?, ?, ?, ?, ?) 
                                    ON CONFLICT(student_id) DO UPDATE SET 
                                    course_section = CASE 
                                        WHEN course_section LIKE '%' || excluded.course_section || '%' THEN course_section 
                                        ELSE course_section || ', ' || excluded.course_section 
                                    END,
                                    registered_by = CASE
                                        WHEN IFNULL(students.registered_by, '') = '' THEN excluded.registered_by
                                        ELSE students.registered_by
                                    END
                                `;
                                db.run(stmt, [cleanId, cleanName, cleanCourseSection, today, registrar]);
                                count++;
                            }
                        });
                    });

                    db.run("COMMIT", (err) => {
                        if (err) {
                            event.reply('file-status', { success: false, message: 'Database error during import.' });
                        } else {
                            rebuildAllRosters(() => {
                                db.all("SELECT * FROM students ORDER BY id DESC", [], (err2, rows) => {
                                    event.reply('load-students', rows || []);
                                    event.reply('file-status', { success: true, message: `Magic complete! Successfully mapped and imported ${count} student records from all sheets.` });
                                });
                            });
                        }
                    });
                });
            } catch (error) {
                event.reply('file-status', { success: false, message: 'Could not read the Excel file. Please ensure it is a valid .xlsx file.' });
            }
        } 
    }); 
});

ipcMain.on('get-subjects', (event) => { db.all("SELECT * FROM subjects ORDER BY subject_name ASC", [], (err, rows) => event.reply('load-subjects', rows || [])); });
ipcMain.on('add-subject', (event, sub) => { db.run("INSERT INTO subjects (subject_name, instructor_name) VALUES (?, ?)", [sub.subject_name, sub.instructor_name], function(err) { db.all("SELECT * FROM subjects ORDER BY subject_name ASC", [], (err2, rows) => event.reply('load-subjects', rows || [])); }); });
ipcMain.on('update-subject', (event, sub) => { db.run("UPDATE subjects SET subject_name = ?, instructor_name = ? WHERE id = ?", [sub.subject_name, sub.instructor_name, sub.id], function(err) { db.all("SELECT * FROM subjects ORDER BY subject_name ASC", [], (err2, rows) => event.reply('load-subjects', rows || [])); }); });
ipcMain.on('delete-subject', (event, id) => { db.run("DELETE FROM subjects WHERE id = ?", [id], function(err) { db.all("SELECT * FROM subjects ORDER BY subject_name ASC", [], (err2, rows) => event.reply('load-subjects', rows || [])); }); });
ipcMain.on('get-quizzes', (event) => { db.all(quizQueryWithCount, [], (err, rows) => event.reply('load-quizzes', rows || [])); });

ipcMain.on('add-quiz', (event, quiz) => {
    db.run("INSERT INTO quizzes (title, subject, items, time_limit, date_created, passcode, tab_limit, passing_rate, idle_time_limit, question_time_limit, require_camera, is_archived, target_section, custom_instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)", 
    [quiz.title, quiz.subject, quiz.items, quiz.time_limit, quiz.date_created, quiz.passcode, quiz.tab_limit, quiz.passing_rate, quiz.idle_time_limit, quiz.question_time_limit || 0, quiz.require_camera ? 1 : 0, quiz.target_section, quiz.custom_instructions || ''], function(err) {
        if (!err) rebuildAllRosters();
        db.all(quizQueryWithCount, [], (err2, rows) => event.reply('load-quizzes', rows || []));
    });
});

ipcMain.on('update-quiz', (event, quiz) => {
    db.run("UPDATE quizzes SET title = ?, subject = ?, items = ?, time_limit = ?, passcode = ?, tab_limit = ?, passing_rate = ?, idle_time_limit = ?, question_time_limit = ?, require_camera = ?, target_section = ?, custom_instructions = ? WHERE id = ?", 
    [quiz.title, quiz.subject, quiz.items, quiz.time_limit, quiz.passcode, quiz.tab_limit, quiz.passing_rate, quiz.idle_time_limit, quiz.question_time_limit || 0, quiz.require_camera ? 1 : 0, quiz.target_section, quiz.custom_instructions || '', quiz.id], function(err) {
        if (!err) rebuildAllRosters();
        db.run(`UPDATE results SET status = CASE WHEN ((score * 100.0) / total_items) >= ? THEN 'Passed' ELSE 'Failed' END WHERE quiz_title = ?`,
        [quiz.passing_rate, quiz.title], function(err2) {
            db.all(quizQueryWithCount, [], (err3, rows) => event.reply('load-quizzes', rows || []));
            db.all(resultsWithSectionQuery, [], (err4, resRows) => event.reply('load-results', resRows || []));
        });
    });
});

ipcMain.on('toggle-archive-quiz', (event, data) => {
    db.run("UPDATE quizzes SET is_archived = ? WHERE id = ?", [data.is_archived, data.id], function(err) {
        db.all(quizQueryWithCount, [], (err2, rows) => event.reply('load-quizzes', rows || []));
    });
});

ipcMain.on('delete-quiz', (event, id) => {
    db.get("SELECT title FROM quizzes WHERE id = ?", [id], (err, row) => {
        if (row) {
            db.run("DELETE FROM questions WHERE quiz_title = ?", [row.title]);
            db.run("DELETE FROM student_roster WHERE quiz_title = ?", [row.title]);
            db.run("DELETE FROM quizzes WHERE id = ?", [id], function(err) {
                rebuildAllRosters();
                db.all(quizQueryWithCount, [], (err2, rows) => event.reply('load-quizzes', rows || []));
            });
        }
    });
});

ipcMain.on('get-student-quizzes', (event, payload) => { 
    const studentId = typeof payload === 'string' ? payload : (payload && payload.studentId);

    if (studentId) {
        getVisibleQuizzesForStudent(studentId, (rows) => {
            event.reply('load-student-quizzes', formatQuizzesForStudent(rows));
        });
        return;
    }

    db.all(activeQuizWithInstructorQuery, [], (err, rows) => event.reply('load-student-quizzes', formatQuizzesForStudent(rows))); 
});

ipcMain.on('get-questions-by-quiz', (event, quizTitle) => { db.all("SELECT * FROM questions WHERE quiz_title = ?", [quizTitle], (err, rows) => event.reply('load-questions', rows || [])); });

ipcMain.on('add-questions', (event, data) => {
    const stmt = db.prepare("INSERT INTO questions (quiz_title, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, extended_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    data.questions.forEach(q => {
        const qType = q.question_type || 'mcq';
        const extData = q.extended_data ? JSON.stringify(q.extended_data) : null;
        stmt.run([data.quizTitle, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, qType, extData]);
    });
    stmt.finalize();
    setTimeout(() => { event.reply('questions-saved-success', data.questions.length); db.all(quizQueryWithCount, [], (err2, rows) => event.reply('load-quizzes', rows || [])); }, 500);
});

ipcMain.on('update-question', (event, data) => { db.run("UPDATE questions SET question_text = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_answer = ? WHERE id = ?", [data.question_text, data.option_a, data.option_b, data.option_c, data.option_d, data.correct_answer, data.id], function(err) { db.all("SELECT * FROM questions WHERE quiz_title = ?", [data.quiz_title], (err2, rows) => event.reply('load-questions', rows || [])); }); });

ipcMain.on('delete-all-questions', (event, quizTitle) => { 
    db.run("DELETE FROM questions WHERE quiz_title = ?", [quizTitle], function(err) { 
        db.all("SELECT * FROM questions WHERE quiz_title = ?", [quizTitle], (err2, rows) => event.reply('load-questions', rows || [])); 
        db.all(quizQueryWithCount, [], (err3, rows) => event.reply('load-quizzes', rows || [])); 
    }); 
});

ipcMain.on('delete-question', (event, data) => { db.run("DELETE FROM questions WHERE id = ?", [data.id], function(err) { db.all("SELECT * FROM questions WHERE quiz_title = ?", [data.quizTitle], (err2, rows) => event.reply('load-questions', rows || [])); db.all(quizQueryWithCount, [], (err3, rows) => event.reply('load-quizzes', rows || [])); }); });
ipcMain.on('request-quiz-questions', (event, quizTitle) => {
    getRandomizedQuizQuestions(quizTitle, (selectedQuestions) => {
        event.reply('receive-quiz-questions', selectedQuestions);
    });
});

ipcMain.on('submit-quiz-result', (event, data) => {
    const answersStr = data.student_answers ? JSON.stringify(data.student_answers) : null;
    db.run("INSERT INTO results (student_name, student_id, quiz_title, score, total_items, status, date_completed, student_answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 
    [data.student_name, data.student_id, data.quiz_title, data.score, data.total_items, data.status, data.date_completed, answersStr], function(err) { 
        if (!err) recordAttendance(data);
        db.all(resultsWithSectionQuery, [], (err2, rows) => event.reply('load-results', rows || [])); 
    });
});

ipcMain.on('get-results', (event) => { db.all(resultsWithSectionQuery, [], (err, rows) => event.reply('load-results', rows || [])); });
ipcMain.on('get-attendance', (event, filters = {}) => {
    getAttendanceRows(filters, (err, rows) => event.reply('load-attendance', rows || []));
});

// Manual attendance edit. The row is identified by student ID, subject, quiz
// title and the recorded timestamp so a change in Quiz A can never touch the
// student's status in Quiz B.
ipcMain.on('update-attendance-status', (event, data) => {
    const payload = data || {};
    const studentId = String(payload.studentId || '').trim();
    const quizTitle = String(payload.quizTitle || '').trim();
    const requestedSubject = String(payload.subject || '').trim();
    const dateRecorded = String(payload.dateRecorded || '').trim();
    const status = String(payload.status || '').trim();
    const allowedStatuses = ['Present', 'Absent', 'Late'];

    if (!studentId || !quizTitle || !dateRecorded || !allowedStatuses.includes(status)) {
        return event.reply('attendance-status-response', { success: false, message: 'Invalid attendance update request.' });
    }

    db.get("SELECT subject FROM quizzes WHERE title = ? LIMIT 1", [quizTitle], (quizErr, quiz) => {
        const canonicalSubject = String((quiz && quiz.subject) || '').trim();
        // Prefer the subject carried by the row itself so a renamed subject cannot
        // redirect the update, and include it in the WHERE clause to keep the
        // quiz/subject pair isolated even when titles repeat.
        const subject = requestedSubject || canonicalSubject;
        const sql = subject
            ? "UPDATE attendance SET status = ? WHERE student_id = ? AND quiz_title = ? AND IFNULL(TRIM(subject), '') = ? AND date_recorded = ?"
            : "UPDATE attendance SET status = ? WHERE student_id = ? AND quiz_title = ? AND date_recorded = ?";
        const params = subject
            ? [status, studentId, quizTitle, subject, dateRecorded]
            : [status, studentId, quizTitle, dateRecorded];

        db.run(sql, params, function(err) {
            if (err) {
                return event.reply('attendance-status-response', { success: false, message: 'Could not update attendance: ' + err.message });
            }
            if (this.changes === 0) {
                return event.reply('attendance-status-response', { success: false, message: 'Attendance record not found. Refresh and try again.' });
            }
            broadcastAttendance();
            event.reply('attendance-status-response', { success: true, message: `Attendance marked ${status}.` });
        });
    });
});
ipcMain.on('delete-result', (event, id) => { db.run("DELETE FROM results WHERE id = ?", [id], function(err) { db.all(resultsWithSectionQuery, [], (err2, rows) => event.reply('load-results', rows || [])); }); });

// Manually adjust a student's score (partial credit) and re-evaluate Passed/Failed.
ipcMain.on('update-result-score', (event, data) => {
    const resultId = data && data.id;
    const requestedScore = Number(data && data.score);

    if (!resultId || !Number.isFinite(requestedScore)) {
        event.reply('result-score-updated', { success: false, message: 'Enter a valid score.' });
        return;
    }

    db.get("SELECT * FROM results WHERE id = ?", [resultId], (err, result) => {
        if (err || !result) {
            event.reply('result-score-updated', { success: false, message: 'Result record not found.' });
            return;
        }

        const totalItems = Number(result.total_items) > 0 ? Number(result.total_items) : 0;
        const boundedScore = totalItems > 0
            ? Math.min(Math.max(requestedScore, 0), totalItems)
            : Math.max(requestedScore, 0);
        const finalScore = Math.round(boundedScore * 100) / 100;

        db.get("SELECT passing_rate FROM quizzes WHERE title = ?", [result.quiz_title], (err2, quiz) => {
            const parsedRate = quiz ? Number(quiz.passing_rate) : NaN;
            const passingRate = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 75;
            const percentage = totalItems > 0 ? (finalScore / totalItems) * 100 : 0;
            const status = percentage >= passingRate ? 'Passed' : 'Failed';

            db.run("UPDATE results SET score = ?, status = ? WHERE id = ?", [finalScore, status, resultId], (err3) => {
                if (err3) {
                    event.reply('result-score-updated', { success: false, message: 'Could not update the score.' });
                    return;
                }

                event.reply('result-score-updated', {
                    success: true,
                    id: resultId,
                    score: finalScore,
                    total_items: totalItems,
                    status: status,
                    percentage: Math.round(percentage * 100) / 100,
                    passing_rate: passingRate
                });

                db.all(resultsWithSectionQuery, [], (err4, rows) => {
                    if (!err4) event.reply('load-results', rows || []);
                });
            });
        });
    });
});
ipcMain.on('get-admins', (event, payload) => {
    isMasterAdminId(payload && payload.requesterId, (ok) => {
        if (!ok) {
            event.reply('load-admins', []);
            event.reply('admin-save-response', { success: false, message: 'Administrator access is required.' });
            return;
        }
        replyAdmins(event);
    });
});

ipcMain.on('add-admin', (event, data) => {
    const payload = data || {};
    isMasterAdminId(payload.requesterId, (ok) => {
        if (!ok) return event.reply('admin-save-response', { success: false, message: 'Only the master administrator can add accounts.' });
        const username = normalizeProfileName(payload.username);
        const password = String(payload.password || '');
        const displayName = normalizeProfileName(payload.display_name) || username;
        if (!username || !password) return event.reply('admin-save-response', { success: false, message: 'Please enter both a username and password.' });
        db.get("SELECT id FROM admins WHERE LOWER(username) = LOWER(?)", [username], (err, existing) => {
            if (existing) return event.reply('admin-save-response', { success: false, message: 'That username is already registered.' });
            db.run("INSERT INTO admins (username, password, display_name) VALUES (?, ?, ?)", [username, password, displayName], (err2) => {
                if (err2) return event.reply('admin-save-response', { success: false, message: 'Could not create the account.' });
                event.reply('admin-save-response', { success: true, message: 'Account created successfully.' });
                replyAdmins(event);
            });
        });
    });
});

ipcMain.on('update-admin', (event, data) => {
    const payload = data || {};
    isMasterAdminId(payload.requesterId, (ok) => {
        if (!ok) return event.reply('admin-save-response', { success: false, message: 'Only the master administrator can update accounts.' });
        if (!payload.id) return event.reply('admin-save-response', { success: false, message: 'No account selected.' });

        const username = normalizeProfileName(payload.username);
        const displayName = normalizeProfileName(payload.display_name);
        const password = payload.password === undefined || payload.password === null ? null : String(payload.password);
        if (!username) return event.reply('admin-save-response', { success: false, message: 'Username cannot be empty.' });

        db.get("SELECT id FROM admins WHERE LOWER(username) = LOWER(?) AND id <> ?", [username, payload.id], (err, existing) => {
            if (existing) return event.reply('admin-save-response', { success: false, message: 'That username is already registered.' });
            const sets = ["username = ?", "display_name = ?"];
            const params = [username, displayName || username];
            if (password !== null && password !== '') { sets.push("password = ?"); params.push(password); }
            params.push(payload.id);
            db.run(`UPDATE admins SET ${sets.join(', ')} WHERE id = ?`, params, (err2) => {
                if (err2) return event.reply('admin-save-response', { success: false, message: 'Could not update the account.' });
                event.reply('admin-save-response', { success: true, message: 'Account updated successfully.' });
                replyAdmins(event);
            });
        });
    });
});

ipcMain.on('delete-admin', (event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : { id: payload };
    isMasterAdminId(data.requesterId, (ok) => {
        if (!ok) return event.reply('admin-save-response', { success: false, message: 'Only the master administrator can remove accounts.' });
        if (Number(data.id) === 1) return event.reply('admin-save-response', { success: false, message: 'The master administrator account cannot be removed.' });
        db.run("DELETE FROM admins WHERE id = ?", [data.id], (err) => {
            if (err) return event.reply('admin-save-response', { success: false, message: 'Could not remove the account.' });
            event.reply('admin-save-response', { success: true, message: 'Account removed.' });
            replyAdmins(event);
        });
    });
});
ipcMain.on('end-of-semester-reset', (event) => { db.run("DELETE FROM students", [], () => { db.run("DELETE FROM attendance", [], () => {}); db.run("DELETE FROM results", [], () => { event.reply('file-status', { success: true, message: 'System reset complete. All students and exam results have been cleared.' }); db.all("SELECT * FROM students ORDER BY id DESC", [], (err, rows) => event.reply('load-students', rows || [])); db.all(resultsWithSectionQuery, [], (err, rows) => event.reply('load-results', rows || [])); }); }); });
ipcMain.on('backup-database', (event) => { dialog.showSaveDialog({ title: 'Backup Database', defaultPath: path.join(app.getPath('documents'), 'quiz_database_backup.sqlite'), filters: [{ name: 'SQLite Database', extensions: ['sqlite'] }] }).then(result => { if (!result.canceled) { fs.copyFile(dbPath, result.filePath, (err) => { event.reply('file-status', { success: !err, message: err ? 'Backup failed.' : 'Database backed up successfully!' }); }); } }); });

ipcMain.on('export-csv', (event, filters = {}) => { 
    db.all(resultsWithSectionQuery, [], (err, rows) => { 
        if (!rows || rows.length === 0) return event.reply('file-status', { success: false, message: 'No results available to export.' }); 

        const proceed = (allowedQuizTitles) => {
            let filteredRows = rows;
            if (filters && typeof filters === 'object') {
                const quizFilter = filters.quizTitle || 'all';
                const sectionFilter = filters.section || 'all';
                const searchFilter = (filters.search || '').toLowerCase();

                filteredRows = rows.filter(r => {
                    const matchesInstructor = !allowedQuizTitles || allowedQuizTitles.has(r.quiz_title);
                    const matchesQuiz = quizFilter === 'all' || r.quiz_title === quizFilter;
                    const matchesSection = sectionFilter === 'all' || (r.course_section || 'Unknown') === sectionFilter;
                    const matchesSearch = !searchFilter ||
                        (r.student_name || '').toLowerCase().includes(searchFilter) ||
                        (r.student_id || '').toLowerCase().includes(searchFilter);
                    return matchesInstructor && matchesQuiz && matchesSection && matchesSearch;
                });
            }

            if (filteredRows.length === 0) {
                return event.reply('file-status', { success: false, message: 'No results match your current filter selection.' });
            }

            const safeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
            const suffix = (filters && filters.quizTitle && filters.quizTitle !== 'all')
                ? `_${filters.quizTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}`
                : '';

            dialog.showSaveDialog({
                title: 'Export Results to CSV',
                defaultPath: path.join(app.getPath('documents'), `Exam_Results${suffix}.csv`),
                filters: [{ name: 'CSV Files', extensions: ['csv'] }]
            }).then(result => { 
                if (!result.canceled && result.filePath) { 
                    let csvContent = "Student Name,Student ID,Section,Quiz Title,Score,Total Items,Status,Date Completed\n"; 
                    filteredRows.forEach(r => {
                        csvContent += `${safeCsv(r.student_name)},${safeCsv(r.student_id)},${safeCsv(r.course_section)},${safeCsv(r.quiz_title)},${r.score},${r.total_items},${safeCsv(r.status)},${safeCsv(r.date_completed)}\n`;
                    }); 
                    fs.writeFile(result.filePath, csvContent, 'utf8', (err2) => {
                        event.reply('file-status', {
                            success: !err2,
                            message: err2 ? 'Export failed.' : `Success! Exported ${filteredRows.length} student result records to CSV.`
                        });
                    }); 
                } 
            }); 
        };

        const instructor = (filters && filters.instructor && filters.instructor !== 'all') ? String(filters.instructor).trim() : '';
        if (!instructor) return proceed(null);

        db.all("SELECT title FROM quizzes WHERE subject IN (SELECT subject_name FROM subjects WHERE LOWER(TRIM(instructor_name)) = LOWER(TRIM(?)))", [instructor], (e, qRows) => {
            proceed(new Set((qRows || []).map(r => r.title)));
        });
    }); 
});

ipcMain.on('export-attendance-pdf', (event, filters = {}) => {
    db.all(attendanceQuery, [], (err, rows) => {
        const allRows = rows || [];
        if (allRows.length === 0) return event.reply('file-status', { success: false, message: 'No attendance records have been generated yet.' });

        getScopedQuizTitlesForInstructor(filters.instructor, (allowedQuizTitles) => {
            const quizFilter = filters.quizTitle || 'all';
            const subjectFilter = String(filters.subject || '').trim();
            const searchFilter = String(filters.search || '').toLowerCase().trim();
            const filtered = allRows.filter(row => {
                const matchesInstructor = !allowedQuizTitles || allowedQuizTitles.has(row.quiz_title);
                const matchesQuiz = quizFilter === 'all' || row.quiz_title === quizFilter;
                const matchesSubject = !subjectFilter || subjectFilter === 'all' || String(row.subject || '') === subjectFilter;
                const matchesSearch = !searchFilter ||
                    String(row.student_name || '').toLowerCase().includes(searchFilter) ||
                    String(row.student_id || '').toLowerCase().includes(searchFilter);
                return matchesInstructor && matchesQuiz && matchesSubject && matchesSearch;
            });

            const stamp = new Date().toISOString().slice(0, 10);
            const suffix = quizFilter !== 'all' ? `_${String(quizFilter).replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
            const subtitleParts = [quizFilter === 'all' ? 'All quizzes' : `Quiz: ${quizFilter}`];
            if (subjectFilter && subjectFilter !== 'all') subtitleParts.push(`Subject: ${subjectFilter}`);
            exportPdfReport(event, {
                title: 'Attendance Report',
                subtitle: subtitleParts.join(' • '),
                headers: ['Student Name', 'Student ID', 'Section', 'Quiz', 'Date Recorded', 'Status'],
                rows: filtered.map(row => [row.student_name || '', row.student_id || '', row.course_section || 'Unknown', row.quiz_title || '', row.date_recorded || '', row.status || 'Present']),
                defaultName: `Attendance_Report${suffix}_${stamp}.pdf`,
                dialogTitle: 'Export Attendance to PDF',
                meta: `${filtered.length} attendance record(s) • Generated ${new Date().toLocaleString('en-US')}`,
                emptyMessage: 'No attendance records match your current filter selection.'
            });
        });
    });
});

ipcMain.on('export-results-pdf', (event, filters = {}) => {
    db.all(resultsWithSectionQuery, [], (err, rows) => {
        const allRows = rows || [];
        if (allRows.length === 0) return event.reply('file-status', { success: false, message: 'No results available to export.' });

        getScopedQuizTitlesForInstructor(filters.instructor, (allowedQuizTitles) => {
            const quizFilter = filters.quizTitle || 'all';
            const sectionFilter = filters.section || 'all';
            const searchFilter = String(filters.search || '').toLowerCase().trim();
            const filtered = allRows.filter(row => {
                const matchesInstructor = !allowedQuizTitles || allowedQuizTitles.has(row.quiz_title);
                const matchesQuiz = quizFilter === 'all' || row.quiz_title === quizFilter;
                const matchesSection = sectionFilter === 'all' || (row.course_section || 'Unknown') === sectionFilter;
                const matchesSearch = !searchFilter ||
                    String(row.student_name || '').toLowerCase().includes(searchFilter) ||
                    String(row.student_id || '').toLowerCase().includes(searchFilter);
                return matchesInstructor && matchesQuiz && matchesSection && matchesSearch;
            });

            const stamp = new Date().toISOString().slice(0, 10);
            const suffix = quizFilter !== 'all' ? `_${String(quizFilter).replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
            const subtitleParts = [quizFilter === 'all' ? 'All quizzes' : `Quiz: ${quizFilter}`];
            if (sectionFilter !== 'all') subtitleParts.push(`Section: ${sectionFilter}`);
            exportPdfReport(event, {
                title: 'Exam Results Report',
                subtitle: subtitleParts.join(' • '),
                headers: ['Student Name', 'Student ID', 'Section', 'Quiz Title', 'Score', 'Status', 'Date Completed'],
                rows: filtered.map(row => [row.student_name || '', row.student_id || '', row.course_section || 'Unknown', row.quiz_title || '', `${row.score} / ${row.total_items}`, row.status || '', row.date_completed || '']),
                defaultName: `Exam_Results${suffix}_${stamp}.pdf`,
                dialogTitle: 'Export Results to PDF',
                meta: `${filtered.length} result record(s) • Generated ${new Date().toLocaleString('en-US')}`,
                emptyMessage: 'No results match your current filter selection.'
            });
        });
    });
});

ipcMain.on('restore-database', (event) => {
    dialog.showOpenDialog({ 
        title: 'Select Database Backup to Restore', 
        filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }], 
        properties: ['openFile'] 
    }).then(result => { 
        if (!result.canceled && result.filePaths.length > 0) { 
            const sourcePath = result.filePaths[0]; 
            
            db.close((err) => {
                if (err) console.error("Error closing database:", err);
                
                fs.copyFile(sourcePath, dbPath, (copyErr) => { 
                    if (copyErr) { 
                        event.reply('file-status', { success: false, message: 'Restore failed: Make sure the file is not currently open.' }); 
                    } else { 
                        event.reply('file-status', { success: true, message: 'Database restored successfully! The application will now restart to apply your changes.' }); 
                        
                        setTimeout(() => { 
                            app.relaunch();
                            app.exit(0);
                        }, 3000); 
                    } 
                }); 
            });
        } 
    }); 
});

// ============================================================================
// SMART QUESTION IMPORTERS (WORD COLOR/HIGHLIGHT + EXCEL COLUMN MAPPING)
// ============================================================================
function importNormalizeCell(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function importNormalizeHeader(value) {
    return importNormalizeCell(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function importEscapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function importDecodeXml(value) {
    return String(value || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&');
}

function importRegexEscape(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRedWordColor(value) {
    const raw = String(value || '').trim();
    if (/^red$/i.test(raw)) return true;
    const hex = raw.replace(/[^0-9a-f]/gi, '');
    if (hex.length !== 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (![r, g, b].every(Number.isFinite)) return false;
    // Accept bright/standard reds and strong maroon-reds, but not browns/oranges.
    if (r >= 150 && g <= 110 && b <= 110) return true;
    return r >= 180 && r >= g + 60 && r >= b + 60;
}

// Read the raw docx XML so direct font color (which Mammoth does not expose) is preserved.
async function extractWordMarkedSegments(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        const zip = await JSZip.loadAsync(buffer);
        const documentFile = zip.file('word/document.xml');
        if (!documentFile) return [];
        const xml = await documentFile.async('string');

        const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
        const segments = [];

        paragraphs.forEach(paragraph => {
            const runs = paragraph.match(/<w:r\b[\s\S]*?<\/w:r>/g) || [];
            let markedBuffer = '';

            runs.forEach(run => {
                const rPrMatch = run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
                const rPr = rPrMatch ? rPrMatch[0] : '';
                const isHighlighted = /<w:highlight\b/i.test(rPr);
                const colorMatch = rPr.match(/<w:color\b[^>]*\bw:val="([^"]+)"/i);
                const isRed = colorMatch ? isRedWordColor(colorMatch[1]) : false;
                const isMarked = isHighlighted || isRed;

                const textParts = run.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) || [];
                const text = textParts
                    .map(part => importDecodeXml(part.replace(/<[^>]+>/g, '')))
                    .join('');

                if (isMarked) {
                    markedBuffer += text;
                } else if (markedBuffer) {
                    segments.push(markedBuffer);
                    markedBuffer = '';
                }
            });

            if (markedBuffer) segments.push(markedBuffer);
        });

        return [...new Set(
            segments
                .map(segment => importNormalizeCell(segment))
                .filter(segment => segment.length >= 1)
        )];
    } catch (error) {
        console.error('Word color scan error:', error);
        return [];
    }
}

function markSegmentsInWordHtml(html, segments) {
    const unique = [...new Set((segments || []).filter(Boolean))].sort((a, b) => b.length - a.length);
    if (unique.length === 0) return String(html || '');

    // Only touch text nodes so a one-letter red run (e.g. "A") cannot corrupt HTML tags.
    return String(html || '')
        .split(/(<[^>]+>)/)
        .map(part => {
            if (!part || part.charAt(0) === '<') return part;

            let text = part;
            unique.forEach(segment => {
                const escaped = importEscapeHtml(segment);
                if (!escaped) return;

                const isSingleToken = /^[A-Za-z0-9]$/.test(segment);
                const prefix = isSingleToken ? '(?<![A-Za-z0-9])' : '';
                const suffix = isSingleToken ? '(?![A-Za-z0-9])' : '';
                try {
                    const pattern = new RegExp(prefix + importRegexEscape(escaped) + suffix, 'g');
                    text = text.replace(pattern, match => `<mark class="correct-answer">${match}</mark>`);
                } catch (error) {
                    text = text.replace(new RegExp(importRegexEscape(escaped), 'g'), match => `<mark class="correct-answer">${match}</mark>`);
                }
            });
            return text;
        })
        .join('');
}

ipcMain.on('import-word-questions', async (event, quizTitle) => {
    try {
        const result = await dialog.showOpenDialog({
            title: 'Select Questions Word Document',
            properties: ['openFile'],
            filters: [{ name: 'Word Documents', extensions: ['docx'] }]
        });

        if (result.canceled || result.filePaths.length === 0) return;

        const filePath = result.filePaths[0];

        const styleMap = [
            'highlight => mark',
            "r[style-name='Red'] => span.red",
            "r[style-name='red'] => span.red",
            "r[style-name='Correct Answer'] => span.correct-answer",
            "r[style-name='Correct'] => span.correct-answer"
        ].join('\n');

        const htmlResult = await mammoth.convertToHtml({ path: filePath }, { styleMap });
        let html = htmlResult.value || '';

        // Mammoth does not expose direct font colour, so scan the docx XML for red runs.
        const markedSegments = await extractWordMarkedSegments(filePath);
        html = markSegmentsInWordHtml(html, markedSegments);

        if (!html || html.trim() === '') {
            event.sender.send('word-questions-extracted', { success: false, message: 'Document is empty.' });
            return;
        }

        const plainFallback = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        event.sender.send('word-questions-extracted', {
            success: true,
            html: html,
            text: plainFallback,
            quizTitle: quizTitle
        });

    } catch (error) {
        console.error('Word import error:', error);
        event.sender.send('word-questions-extracted', { success: false, message: error.message });
    }
});

// ---------------------------------------------------------------------------
// EXCEL QUESTION IMPORT
// ---------------------------------------------------------------------------
const EXCEL_HEADER_ALIASES = {
    question: ['question', 'questiontext', 'questiontitle', 'questions', 'prompt', 'item', 'itemquestion', 'statement'],
    a: ['optiona', 'choicea', 'a', 'answera', 'option1', 'choice1', '1'],
    b: ['optionb', 'choiceb', 'b', 'answerb', 'option2', 'choice2', '2'],
    c: ['optionc', 'choicec', 'c', 'answerc', 'option3', 'choice3', '3'],
    d: ['optiond', 'choiced', 'd', 'answerd', 'option4', 'choice4', '4'],
    correct: ['correct', 'correctanswer', 'answer', 'answerkey', 'key', 'correctoption', 'correctchoice', 'correctletter', 'ans']
};

function detectExcelHeader(rows) {
    const maxScan = Math.min(rows.length, 15);
    for (let r = 0; r < maxScan; r++) {
        const row = rows[r] || [];
        const map = { question: null, a: null, b: null, c: null, d: null, correct: null };
        let matches = 0;

        row.forEach((cell, columnIndex) => {
            const key = importNormalizeHeader(cell);
            if (!key) return;
            Object.keys(EXCEL_HEADER_ALIASES).forEach(field => {
                if (map[field] === null && EXCEL_HEADER_ALIASES[field].includes(key)) {
                    map[field] = columnIndex;
                    matches++;
                }
            });
        });

        if (map.question !== null && matches >= 2 && (map.a !== null || map.correct !== null)) {
            return { rowIndex: r, map: map };
        }
    }
    return null;
}

function detectHeaderlessExcelMap(rows) {
    const dataRows = rows.filter(row => importNormalizeCell((row || [])[0]));
    let offset = 0;
    if (dataRows.length > 0) {
        const numericFirst = dataRows.filter(row => /^\d{1,4}$/.test(importNormalizeCell(row[0]))).length;
        if (numericFirst >= Math.max(1, Math.ceil(dataRows.length * 0.6)) && importNormalizeCell(dataRows[0][1])) {
            offset = 1;
        }
    }
    return { question: offset, a: offset + 1, b: offset + 2, c: offset + 3, d: offset + 4, correct: offset + 5 };
}

function splitInlineOptionText(text) {
    const source = String(text || '');
    const markerRegex = /(^|[\s;,])(\*{0,3}\s*)(?:\(\s*([A-Da-d])\s*\)|\[\s*([A-Da-d])\s*\]|([A-Da-d])\s*[\.\)\:\-])\s*/g;
    const matches = [];
    let match;
    while ((match = markerRegex.exec(source)) !== null) {
        matches.push({
            label: (match[3] || match[4] || match[5] || '').toUpperCase(),
            markerStart: match.index + match[1].length,
            textStart: markerRegex.lastIndex,
            marked: (match[2] || '').includes('*')
        });
    }
    if (matches.length < 2) return null;

    const prefix = source.slice(0, matches[0].markerStart).trim();
    const options = matches.map((entry, index) => {
        const end = index + 1 < matches.length ? matches[index + 1].markerStart : source.length;
        let optionText = source.slice(entry.textStart, end).trim();
        const marked = entry.marked || /^\*/.test(optionText);
        optionText = optionText.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();
        return { label: entry.label, text: optionText, marked: marked };
    });

    return { prefix: prefix, options: options };
}

function cleanExcelOption(value) {
    const raw = importNormalizeCell(value);
    const marked = /^\s*\*+/.test(raw) || /\*+\s*$/.test(raw);
    let text = raw.replace(/^\s*\*+\s*/, '').replace(/\s*\*+\s*$/, '').trim();
    text = text.replace(/^[\(\[]?[A-Da-d][\.\)\:\-]\s*/, '').trim();
    return { text: text, marked: marked };
}

function resolveExcelCorrectAnswer(rawValue, optionTexts, markedIndex) {
    const letters = ['A', 'B', 'C', 'D'];
    if (markedIndex >= 0 && markedIndex < 4) return letters[markedIndex];

    let value = importNormalizeCell(rawValue);
    if (!value) return 'A';
    value = value.replace(/^(?:correct\s*answer|correct|answer|key|ans)\s*[:\-]?\s*/i, '').trim();

    const letterOnly = value.match(/^[\(\[]?\s*([A-Da-d])\s*[\)\]]?[\.\)\:\-]?$/);
    if (letterOnly) return letterOnly[1].toUpperCase();

    if (/^\d+$/.test(value)) {
        const index = parseInt(value, 10);
        if (index >= 1 && index <= 4) return letters[index - 1];
    }

    const optionWord = value.match(/(?:option|choice)\s*[\(\[]?\s*([A-Da-d])/i);
    if (optionWord) return optionWord[1].toUpperCase();

    const textIndex = optionTexts.findIndex(text => importNormalizeCell(text).toLowerCase() === value.toLowerCase());
    if (textIndex >= 0 && textIndex < 4) return letters[textIndex];

    return 'A';
}

function parseExcelQuestionWorkbook(filePath) {
    const workbook = xlsx.readFile(filePath);
    const questions = [];

    workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) return;
        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
        if (!rows || rows.length === 0) return;

        const detectedHeader = detectExcelHeader(rows);
        const mapping = detectedHeader ? detectedHeader.map : detectHeaderlessExcelMap(rows);
        const startRow = detectedHeader ? detectedHeader.rowIndex + 1 : 0;

        for (let r = startRow; r < rows.length; r++) {
            const row = rows[r] || [];
            const getCell = (column) => (column === null || column === undefined) ? '' : importNormalizeCell(row[column]);

            let questionText = getCell(mapping.question);
            if (!questionText) continue;

            // Remove a leading question number; the app numbers questions automatically.
            questionText = questionText.replace(/^\d{1,3}\s*[\.\)\:\-]\s*/, '').trim();
            if (!questionText) continue;

            let rawOptions = [getCell(mapping.a), getCell(mapping.b), getCell(mapping.c), getCell(mapping.d)];
            let inline = null;

            // If the options were squeezed into the question cell or one option cell, split them.
            const nonEmptyOptions = rawOptions.filter(Boolean);
            if (nonEmptyOptions.length === 0) {
                inline = splitInlineOptionText(questionText);
                if (inline && inline.options.length >= 2) {
                    questionText = inline.prefix || questionText;
                    rawOptions = [0, 1, 2, 3].map(i => inline.options[i] ? inline.options[i].text : '');
                }
            } else if (nonEmptyOptions.length === 1) {
                const squeeze = splitInlineOptionText(nonEmptyOptions[0]);
                if (squeeze && squeeze.options.length >= 2) {
                    rawOptions = [0, 1, 2, 3].map(i => squeeze.options[i] ? squeeze.options[i].text : '');
                }
            }

            if (!questionText) continue;

            const cleanedOptions = rawOptions.map(cleanExcelOption);
            const optionTexts = cleanedOptions.map(option => option.text);
            const populated = optionTexts.filter(Boolean).length;
            if (populated < 2) continue;

            const markedIndex = cleanedOptions.findIndex(option => option.marked && option.text);
            const correctAnswer = resolveExcelCorrectAnswer(getCell(mapping.correct), optionTexts, markedIndex);

            const isTrueFalse = populated === 2 &&
                /^true$/i.test(optionTexts[0] || '') && /^false$/i.test(optionTexts[1] || '');

            questions.push({
                question_text: questionText,
                option_a: optionTexts[0] || '',
                option_b: optionTexts[1] || '',
                option_c: isTrueFalse ? '' : (optionTexts[2] || ''),
                option_d: isTrueFalse ? '' : (optionTexts[3] || ''),
                correct_answer: correctAnswer,
                question_type: isTrueFalse ? 'tf' : 'mcq',
                extended_data: null
            });
        }
    });

    return questions;
}

ipcMain.on('import-excel-questions', async (event, quizTitle) => {
    try {
        const result = await dialog.showOpenDialog({
            title: 'Select Questions Excel Workbook',
            properties: ['openFile'],
            filters: [{ name: 'Excel Workbooks', extensions: ['xlsx', 'xls', 'csv'] }]
        });

        if (result.canceled || result.filePaths.length === 0) return;

        const parsedQuestions = parseExcelQuestionWorkbook(result.filePaths[0]);
        if (parsedQuestions.length === 0) {
            event.sender.send('excel-questions-imported', {
                success: false,
                message: 'No valid questions were found. Use columns for Question, Option A, Option B, Option C, Option D, and Correct Answer.'
            });
            return;
        }

        const stmt = db.prepare("INSERT INTO questions (quiz_title, question_text, option_a, option_b, option_c, option_d, correct_answer, question_type, extended_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        parsedQuestions.forEach(question => {
            stmt.run([
                quizTitle,
                question.question_text,
                question.option_a,
                question.option_b,
                question.option_c,
                question.option_d,
                question.correct_answer,
                question.question_type,
                null
            ]);
        });

        stmt.finalize(() => {
            event.sender.send('excel-questions-imported', {
                success: true,
                count: parsedQuestions.length,
                message: `Imported ${parsedQuestions.length} question${parsedQuestions.length === 1 ? '' : 's'} from Excel.`
            });
            db.all("SELECT * FROM questions WHERE quiz_title = ?", [quizTitle], (err, rows) => {
                event.sender.send('load-questions', rows || []);
            });
            db.all(quizQueryWithCount, [], (err, rows) => {
                event.sender.send('load-quizzes', rows || []);
            });
        });
    } catch (error) {
        console.error('Excel import error:', error);
        event.sender.send('excel-questions-imported', {
            success: false,
            message: 'Could not read the Excel file: ' + error.message
        });
    }
});

// ============================================================================
// 1. CLOUDFLARE QUICK TUNNEL ENGINE (HYBRID GLOBAL ACCESS - HTTP/2 + TIMEOUT)
// ============================================================================
let cloudflareProcess = null;
let currentCloudflareUrl = null;

function getCloudflaredPath() {
    if (app.isPackaged) {
        const packagedPath = path.join(process.resourcesPath, 'cloudflared.exe');
        if (fs.existsSync(packagedPath)) return packagedPath;
    }
    const localPath = path.join(__dirname, 'cloudflared.exe');
    if (fs.existsSync(localPath)) return localPath;
    return 'cloudflared'; // Fallback if installed globally in Windows PATH
}

function stopCloudflareTunnel() {
    if (cloudflareProcess) {
        try { cloudflareProcess.kill(); } catch (e) {}
        cloudflareProcess = null;
    }
    currentCloudflareUrl = null;
}

ipcMain.on('start-cloudflare-tunnel', (event) => {
    if (cloudflareProcess && currentCloudflareUrl) {
        event.reply('cloudflare-tunnel-status', { status: 'online', url: currentCloudflareUrl });
        return;
    }

    const binPath = getCloudflaredPath();
    if (binPath.endsWith('cloudflared.exe') && !fs.existsSync(binPath)) {
        event.reply('cloudflare-tunnel-status', {
            status: 'error',
            message: 'cloudflared.exe was not found in your project folder. Run the curl download command first.'
        });
        return;
    }

    event.reply('cloudflare-tunnel-status', { status: 'connecting' });

    let tunnelTimeout = null;
    let lastErrorLine = '';

    try {
        cloudflareProcess = spawn(
            binPath,
            ['tunnel', '--url', `http://localhost:${PORT}`, '--protocol', 'http2', '--no-autoupdate'],
            { windowsHide: true }
        );

        tunnelTimeout = setTimeout(() => {
            if (!currentCloudflareUrl) {
                stopCloudflareTunnel();
                const adminWindow = BrowserWindow.getAllWindows()[0];
                if (adminWindow) {
                    adminWindow.webContents.send('cloudflare-tunnel-status', {
                        status: 'error',
                        message: lastErrorLine || 'Cloudflare Tunnel timed out. Check your internet connection or allow cloudflared.exe in Windows Firewall.'
                    });
                }
            }
        }, 20000);

        const handleTunnelOutput = (data) => {
            const output = data.toString();
            const lines = output.split(/\r?\n/).filter(l => l.trim() !== '');
            if (lines.length > 0) lastErrorLine = lines[lines.length - 1].trim();

            const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match && !currentCloudflareUrl) {
                clearTimeout(tunnelTimeout);
                currentCloudflareUrl = `${match[0]}/student.html`;
                const adminWindow = BrowserWindow.getAllWindows()[0];
                if (adminWindow) {
                    adminWindow.webContents.send('cloudflare-tunnel-status', {
                        status: 'online',
                        url: currentCloudflareUrl
                    });
                }
            }
        };

        cloudflareProcess.stdout.on('data', handleTunnelOutput);
        cloudflareProcess.stderr.on('data', handleTunnelOutput);

        cloudflareProcess.on('error', (err) => {
            clearTimeout(tunnelTimeout);
            stopCloudflareTunnel();
            event.reply('cloudflare-tunnel-status', {
                status: 'error',
                message: 'Could not start cloudflared.exe: ' + err.message
            });
        });

        cloudflareProcess.on('close', () => {
            clearTimeout(tunnelTimeout);
            stopCloudflareTunnel();
            const adminWindow = BrowserWindow.getAllWindows()[0];
            if (adminWindow) {
                adminWindow.webContents.send('cloudflare-tunnel-status', { status: 'offline' });
            }
        });
    } catch (err) {
        if (tunnelTimeout) clearTimeout(tunnelTimeout);
        event.reply('cloudflare-tunnel-status', { status: 'error', message: err.message });
    }
});

ipcMain.on('stop-cloudflare-tunnel', (event) => {
    stopCloudflareTunnel();
    event.reply('cloudflare-tunnel-status', { status: 'offline' });
});

app.on('will-quit', () => {
    stopCloudflareTunnel();
});

// ============================================================================
// 2. IN-APP AUTO-UPDATER ENGINE (electron-updater)
// ============================================================================
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false; // Let the instructor choose to download or skip
    autoUpdater.autoInstallOnAppQuit = true;
} catch (e) {
    console.log("electron-updater not installed yet. Run: npm install electron-updater");
}

function sendUpdateEvent(payload) {
    const adminWindow = BrowserWindow.getAllWindows()[0];
    if (adminWindow) adminWindow.webContents.send('app-update-event', payload);
}

if (autoUpdater) {
    autoUpdater.on('checking-for-update', () => {
        sendUpdateEvent({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
        sendUpdateEvent({ state: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', (info) => {
        sendUpdateEvent({ state: 'not-available', version: info.version });
    });

    autoUpdater.on('download-progress', (progressObj) => {
        sendUpdateEvent({
            state: 'downloading',
            percent: Math.round(progressObj.percent || 0)
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        sendUpdateEvent({ state: 'downloaded', version: info.version });
    });

    autoUpdater.on('error', (err) => {
        sendUpdateEvent({ state: 'error', message: err ? err.message : 'Update check failed.' });
    });
}

ipcMain.on('get-app-version', (event) => {
    event.reply('app-version-response', app.getVersion());
});

ipcMain.on('check-for-updates', (event) => {
    if (!autoUpdater) {
        event.reply('app-update-event', {
            state: 'error',
            message: 'electron-updater is not installed. Run "npm install electron-updater" in terminal.'
        });
        return;
    }
    if (!app.isPackaged) {
        event.reply('app-update-event', {
            state: 'dev-mode',
            message: 'Updater works in packaged builds (npm run dist). Current dev version: v' + app.getVersion()
        });
        return;
    }
    autoUpdater.checkForUpdates();
});

ipcMain.on('start-download-update', () => {
    if (autoUpdater) autoUpdater.downloadUpdate();
});

ipcMain.on('quit-and-install-update', () => {
    stopCloudflareTunnel();
    if (autoUpdater) autoUpdater.quitAndInstall();
});

// ============================================================================
// 3. ADMIN IPC CONTROLS FOR 3-LAYER PROCTORING SHIELD
// ============================================================================
ipcMain.on('get-security-state', () => {
    broadcastSecurityState();
});

ipcMain.on('set-expected-students', (event, count) => {
    const parsed = parseInt(count, 10);
    expectedStudentCount = (!isNaN(parsed) && parsed > 0) ? parsed : 0;
    checkAutoGatekeeperLock();
    broadcastSecurityState();
});

ipcMain.on('toggle-gatekeeper-lock', () => {
    isExamRoomLocked = !isExamRoomLocked;
    // Automatically retire the whiteboard PIN as soon as the instructor locks the room
    if (isExamRoomLocked) {
        dynamicRoomPin = String(Math.floor(1000 + Math.random() * 9000));
    }
    broadcastSecurityState();
});

ipcMain.on('cycle-dynamic-pin', () => {
    dynamicRoomPin = String(Math.floor(1000 + Math.random() * 9000));
    broadcastSecurityState();
});

ipcMain.on('reset-student-sessions', (event) => {
    activeStudentSessions.clear();
    redeemedStudentPins.clear();
    unlockedStudentIds.clear();
    isExamRoomLocked = false;
    broadcastSecurityState();
    event.reply('file-status', {
        success: true,
        message: 'All student device tokens, single-use PIN locks, and room lock status have been reset.'
    });
});