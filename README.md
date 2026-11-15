# Offline Exam System v2.1.4 - Final Feature Expansion

## Current State
The previous agent partially updated the `student.html` CSS (the login page looks great) but stopped before completing the rest of the portal UI and the `face-api.js` integration. We are making one final push for the v2.1.4 release to finish the anti-cheat mechanics and introduce a personalized, filtered student onboarding flow.

**Anti-cheat calibration is complete (v2.1.4):** the camera buffer is a 3.0-second window, tab-switching is trapped and pauses the exam, and every warning is tallied in the database and surfaced to the instructor as a badge. See section 4.

## 1. UI Polish & Face Detection (Resuming)
- [ ] **Audit & Preserve:** Keep the recently updated CSS for the login page in `student.html`. Do not revert it.
- [ ] **Text Update:** Change the placeholder and label of the Student ID login input to clearly say "Please type your student ID number".
- [ ] **Finish CSS Modernization:** Apply the modern UI design to the rest of the student portal (the exam list, the active quiz view). **CRITICAL: DO NOT alter, rename, or remove any DOM `id` attributes.**
- [x] **Face Detection Loop:** Completed `face-api.js` integration in `student.html`. Loads `tinyFaceDetector` and monitors the video feed every **1.5s**; the exam pauses and `modal-face-warning` appears after **2 consecutive misses (~3.0s)**. The timer resumes when the student dismisses it. (Calibrated in section 4.)

## 2. Smart Exam Filtering (New Feature)
- [ ] **Student Roster Logic:** Currently, students see all active quizzes. Update `main.js` and `student.html` so that after entering their ID, the system only returns quizzes where that specific Student ID is enrolled/uploaded by the instructor. Hide all subjects belonging to other instructors or classes they aren't part of. *(Note: If a student roster table doesn't exist yet, create a lightweight SQLite table/mapping to handle this).*

## 3. Pre-Flight Instructions Screen (New Feature)
- [ ] **Database & Teacher UI:** Add a `custom_instructions` TEXT column to the `quizzes` table in `main.js`. Update the "Create/Edit Quiz" modal in `index.html` so teachers can optionally type their own rules for the test.
- [ ] **Student Onboarding Modal:** In `student.html`, after the student selects their quiz but BEFORE the camera check or PIN entry, show a new "Pre-Flight Instructions" screen.
    - **Global Defaults:** Always display: "1. Turn on Do Not Disturb to block notifications. 2. Close all background apps and floating windows. 3. Ensure your face is clearly visible."
    - **Custom Instructions:** Display the teacher's specific rules for that quiz below the defaults.
    - **Action:** Require the student to click a button saying "I Understand & Agree" to proceed to the camera check/PIN.

## 4. Anti-Cheat Calibration & Incident Logging (v2.1.4 - Completed)
- [x] **3-Second Camera Buffer:** `FACE_MONITOR_INTERVAL_MS = 1500` with `FACE_MISS_TOLERANCE_TICKS = 2` in `student.html`, so `modal-face-warning` only fires after roughly 3.0 seconds without a face. A single dropped detection tick no longer pauses the exam.
- [x] **Tab-Switching / Visibility Trap:** `visibilitychange`, `blur` (with a 1.2s debounce) and fullscreen-exit listeners catch tab switches, minimized browsers, snipping tools and floating overlays. Each hit **instantly pauses both timers**, blurs the question paper (`#quiz-card-container.exam-focus-lost`), and shows a warning modal reading: "Window focus lost. Please stay on the exam page." A 2-second cooldown collapses simultaneous blur + visibilitychange into one strike.
- [x] **No Auto-Submit On Warnings:** Warnings only pause, blur and record. The old "exceeded maximum warnings → terminate and submit" branch was removed; accumulating incidents can never submit an exam.
- [x] **Incident Logging (Database):** New `exam_incidents` table (`student_id`, `quiz_title`, `student_name`, `incident_count`, `last_reason`, `last_updated`, unique per student + quiz) created non-destructively on startup in `main.js`.
- [x] **Silent Counter Endpoint:** `POST /api/log-incident` performs an atomic `+1` upsert, returns the running tally, pushes the live cheat alarm (with the tally) to the dashboard, and refreshes the teacher's Results/Attendance data. Called by the face warning and every tab/focus/clipboard/idle violation.
- [x] **Admin Dashboard Display:** Results and Attendance queries now return `incident_count`, and both tables gained a **Warnings** column rendering a red `⚠ N Warnings` badge (em dash when clean). The live security alarm card also shows the running total.
- [x] **Guardrail:** No DOM `id` was renamed, altered or removed, and the badges reuse the existing flat/hairline design tokens.

## Instructions for Active AI Agent
1. Read `main.js`, `script.js`, and `student.html`.
2. Implement the missing Face Detection logic and safely finish styling the student portal.
3. Implement the Student ID filtering so students only see their assigned exams.
4. Implement the Custom Instructions database schema, teacher UI, and student Pre-Flight screen.
5. Verify your syntax and update this file when done.
6. **Handoff Protocol:** When you finish these tasks, append a new section at the very bottom of this file titled "⚠️ NOTE FOR FREEBUFF ⚠️". Write a quick brief summarizing exactly what you implemented, any architectural quirks you noticed, and anything Freebuff needs to know before taking over for the v2.2.0 shift.

---

## ⚠️ NOTE FOR FREEBUFF ⚠️

### What was implemented in this pass (anti-cheat calibration, v2.1.4)
1. **Camera buffer calibrated to exactly 3.0s** (`student.html`): `FACE_MONITOR_INTERVAL_MS = 1500`, `FACE_MISS_TOLERANCE_TICKS = 2`. Warning copy now says "about 3 seconds". The 4.5s post-start grace period and the 4s post-dismissal cooldown were kept so students aren't punished for settling into the camera.
2. **Focus-loss trap** (`student.html`): `visibilitychange`, debounced `blur`, and fullscreen-exit listeners route into `handleSecurityViolation()`, which now pauses both timers, adds `exam-focus-lost` to `#quiz-card-container` (CSS blur + pointer-events off), records the incident, and shows "Window focus lost. Please stay on the exam page." Dismissing restores focus, fullscreen and timers.
3. **No auto-submit on warnings**: the `cheatWarnings > activeTabLimit` termination branch was deleted. Warnings are now informational + logged only.
4. **Incident Logging** (`main.js`): `exam_incidents` table + `POST /api/log-incident` (atomic upsert, returns the running tally, fires `trigger-cheat-alarm` with `incident_count`, and re-broadcasts `load-results` + `load-attendance` so badges refresh live). Both read queries expose `incident_count`.
5. **Admin UI** (`index.html`, `script.js`): new **Warnings** column in the Results and Attendance tables with a red `⚠ N Warnings` badge, and the tally appended to the live security alarm card.

### Architectural quirks worth knowing
- The incident counter is keyed by **student + quiz**, not by attempt, so a retake of the same quiz continues the same tally. If per-attempt logging is needed for v2.2.0, add an attempt/session id to the unique key.
- `activeTabLimit` (tab_limit) is still read from the quiz and stored on the student session, but it no longer controls submission — it is effectively vestigial and could be repurposed as a "notify instructor at N warnings" threshold.
- **The split-screen / viewport-shrink trap still auto-submits** (`triggerResizeAutoSubmit`). It was deliberately left untouched because it is a pre-existing hard rule, but it is the one remaining violation path that terminates the exam. Softening it is a one-line change if ACA wants it.
- The incident tally is stored in SQLite only; CSV/PDF exports still export the original column set (no Warnings column yet).
- Every incident also refreshes the full results + attendance lists. That is fine at classroom scale, but if the roster grows large, throttle those broadcasts.

### Verification performed
`node --check` on `main.js`, `script.js`, and the inline script of `student.html`; the app was launched locally and `POST /api/log-incident` returned `1` then `2` for the same student/quiz, confirmed in `database.sqlite` (test row removed afterwards); the new `resultsWithSectionQuery` and attendance query were run against a copy of the real database and both returned `incident_count`.
