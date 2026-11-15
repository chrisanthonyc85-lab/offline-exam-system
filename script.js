const { ipcRenderer, clipboard } = require('electron');

let desktopAnswerSheet = []; 
let currentLoadedResults = []; 
let activeAnalysisResultId = null;
let backupDeletedQuestions = {}; // Memory bank for the Recover feature

let passFailChartInstance = null; 
let examTimerInterval = null; 

// ============================================================================
// INSTRUCTOR PROFILE STATE (session-scoped data isolation)
// ============================================================================
const INSTRUCTOR_STORAGE_KEY = 'activeInstructor';
const AUTH_KEYS = {
    id: 'authUserId',
    username: 'authUsername',
    displayName: 'authDisplayName',
    isAdmin: 'authIsAdmin'
};
const UNLOCKED_STORAGE_KEY = 'unlockedInstructorProfiles';

let allSubjects = [];
let allQuizzes = [];
let currentDesktopStudentId = '';
let allResults = [];
let allAttendance = [];
let allStudents = [];
let subjectsLoaded = false;
let pendingInstructorPrompt = false;

let adminAccounts = [];
let instructorProfileNames = [];
let instructorAccounts = [];
let revealedAdminPasswords = new Set();
let pendingAccessTarget = null;

function normalizeInstructorName(name) {
    return String(name === null || name === undefined ? '' : name).trim();
}

function getAuthUser() {
    return {
        id: sessionStorage.getItem(AUTH_KEYS.id),
        username: sessionStorage.getItem(AUTH_KEYS.username) || '',
        displayName: sessionStorage.getItem(AUTH_KEYS.displayName) || '',
        isAdmin: sessionStorage.getItem(AUTH_KEYS.isAdmin) === 'true'
    };
}

function isMasterAdmin() {
    return sessionStorage.getItem('role') === 'admin' && getAuthUser().isAdmin;
}

function getUnlockedProfiles() {
    try {
        const raw = sessionStorage.getItem(UNLOCKED_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function rememberUnlockedProfile(name) {
    const list = getUnlockedProfiles();
    if (!list.some(n => n.toLowerCase() === name.toLowerCase())) {
        list.push(name);
        sessionStorage.setItem(UNLOCKED_STORAGE_KEY, JSON.stringify(list));
    }
}

function hasInstructorAccount(name) {
    const key = normalizeInstructorName(name).toLowerCase();
    return instructorAccounts.some(a => normalizeInstructorName(a.displayName).toLowerCase() === key ||
        normalizeInstructorName(a.username).toLowerCase() === key);
}

function isOwnInstructorProfile(name) {
    const auth = getAuthUser();
    const key = normalizeInstructorName(name).toLowerCase();
    return !!key && (
        normalizeInstructorName(auth.displayName).toLowerCase() === key ||
        normalizeInstructorName(auth.username).toLowerCase() === key
    );
}

function canAccessInstructor(name) {
    if (isMasterAdmin()) return true;
    const target = name === 'all' ? 'all' : normalizeInstructorName(name);
    if (target === 'all') return getUnlockedProfiles().some(n => n === 'all');
    if (isOwnInstructorProfile(target)) return true;
    return getUnlockedProfiles().some(n => n.toLowerCase() === target.toLowerCase());
}

function getProfileOptions() {
    const names = new Set();
    (instructorProfileNames || []).forEach(n => { const clean = normalizeInstructorName(n); if (clean) names.add(clean); });
    (allSubjects || []).forEach(s => { const clean = normalizeInstructorName(s.instructor_name); if (clean) names.add(clean); });
    (instructorAccounts || []).forEach(a => { const clean = normalizeInstructorName(a.displayName); if (clean) names.add(clean); });
    return [...names].sort((a, b) => a.localeCompare(b));
}

function getActiveInstructor() {
    const stored = sessionStorage.getItem(INSTRUCTOR_STORAGE_KEY);
    return (stored && stored.trim() !== '') ? stored : 'all';
}

function isMasterInstructorView() {
    return getActiveInstructor() === 'all';
}

function instructorNamesMatch(a, b) {
    return normalizeInstructorName(a).toLowerCase() === normalizeInstructorName(b).toLowerCase();
}

function getScopedSubjects(subjects = allSubjects) {
    if (isMasterInstructorView()) return subjects || [];
    const active = getActiveInstructor();
    return (subjects || []).filter(s => instructorNamesMatch(s.instructor_name, active));
}

// Returns a Set of subject names for the active instructor, or null for Master View.
function getActiveSubjectNames() {
    if (isMasterInstructorView()) return null;
    return new Set(getScopedSubjects().map(s => s.subject_name));
}

// Returns a Set of quiz titles owned by the active instructor, or null for Master View.
function getActiveQuizTitles() {
    if (isMasterInstructorView()) return null;
    const subjects = getActiveSubjectNames();
    return new Set(allQuizzes.filter(q => subjects.has(q.subject)).map(q => q.title));
}

function quizBelongsToActiveInstructor(quiz) {
    if (isMasterInstructorView()) return true;
    const subjects = getActiveSubjectNames();
    return subjects.has(quiz.subject);
}

function resultBelongsToActiveInstructor(result) {
    if (isMasterInstructorView()) return true;
    const quiz = allQuizzes.find(q => q.title === result.quiz_title);
    if (!quiz) return false;
    return quizBelongsToActiveInstructor(quiz);
}

function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsAttr(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// CUSTOM ALERT MODAL
window.alert = function(message) {
    const modal = document.getElementById('modal-alert');
    if (!modal) return; 
    
    const msgEl = document.getElementById('alert-message');
    const titleEl = document.getElementById('alert-title');
    const iconContainer = document.getElementById('alert-icon-container');
    const icon = document.getElementById('alert-icon');
    const btn = document.getElementById('alert-btn');
    
    msgEl.innerText = message;
    const msgLower = message.toLowerCase();

    if (msgLower.includes('success') || msgLower.includes('copied')) {
        titleEl.innerText = 'Success!';
        iconContainer.className = 'w-16 h-16 bg-green-50 dark:bg-green-900/20 text-green-500 dark:text-green-400 rounded-full flex items-center justify-center text-3xl mx-auto mb-4';
        icon.className = 'fa-solid fa-circle-check';
        btn.className = 'btn btn-primary btn-block';
    } else if (msgLower.includes('error') || msgLower.includes('invalid') || msgLower.includes('hold on') || msgLower.includes('please') || msgLower.includes('incorrect') || msgLower.includes('failed')) {
        titleEl.innerText = 'Attention Required';
        iconContainer.className = 'w-16 h-16 bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400 rounded-full flex items-center justify-center text-3xl mx-auto mb-4';
        icon.className = 'fa-solid fa-triangle-exclamation';
        btn.className = 'btn btn-primary btn-block';
    } else {
        titleEl.innerText = 'System Notification';
        iconContainer.className = 'w-16 h-16 bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 rounded-full flex items-center justify-center text-3xl mx-auto mb-4';
        icon.className = 'fa-solid fa-circle-info';
        btn.className = 'btn btn-primary btn-block';
    }

    openModal('modal-alert');
};

let skipDeleteConfirm = false;
let pendingConfirmCallback = null;

function customConfirm(message, callback) {
    if (skipDeleteConfirm) { callback(); return; }
    const msgElement = document.getElementById('confirm-message');
    if (msgElement) msgElement.innerText = message;
    pendingConfirmCallback = callback;
    const checkbox = document.getElementById('dont-ask-again');
    if (checkbox) checkbox.checked = false;
    openModal('modal-confirm');
}

function closeConfirmModal(isConfirmed) {
    closeModal('modal-confirm');
    const checkbox = document.getElementById('dont-ask-again');
    if (checkbox && checkbox.checked) skipDeleteConfirm = true; 
    if (isConfirmed && pendingConfirmCallback) pendingConfirmCallback(); 
    pendingConfirmCallback = null;
}

const originalAlert = window.alert;
window.alert = function(message) { originalAlert(message); window.focus(); };

window.addEventListener('DOMContentLoaded', () => {
    injectAutoLockControl();
    ipcRenderer.send('get-server-ip'); 
    ipcRenderer.send('get-students'); 
    ipcRenderer.send('get-subjects');
    ipcRenderer.send('get-quizzes');
    ipcRenderer.send('get-results'); 
    ipcRenderer.send('get-attendance', { instructor: getActiveInstructor() });
    ipcRenderer.send('get-instructor-profiles');
    ipcRenderer.send('get-app-version');
    ipcRenderer.send('get-security-state');
    setTimeout(applyBranding, 100); 
    updateActiveInstructorHeader();
    updateClock();
    setInterval(updateClock, 1000);
});

ipcRenderer.on('server-ip-response', (event, ip) => { 
    const ipDisplay = document.getElementById('display-server-ip'); 
    if (ipDisplay) ipDisplay.innerText = `http://${ip}:3000/student.html`; 
});

function updateClock() {
    const now = new Date();
    const timeEl = document.getElementById('live-time');
    const dateEl = document.getElementById('live-date');
    const dayEl = document.getElementById('live-day');
    if (timeEl) timeEl.innerText = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    if (dateEl) dateEl.innerText = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (dayEl) dayEl.innerText = now.toLocaleDateString('en-US', { weekday: 'long' });
}

function switchView(viewId) {
    if (viewId === 'take-quiz') {
        document.getElementById('admin-layout').classList.add('hidden');
        document.getElementById('view-student-portal').classList.remove('hidden');
        const portalAdminBtn = document.getElementById('portal-admin-return-btn');
        if (portalAdminBtn) {
            if (sessionStorage.getItem('role') === 'admin') portalAdminBtn.classList.remove('hidden');
            else portalAdminBtn.classList.add('hidden');
        }
        ipcRenderer.send('get-student-quizzes', { studentId: currentDesktopStudentId || '' });
        return; 
    }

    document.getElementById('admin-layout').classList.remove('hidden');
    document.getElementById('view-student-portal').classList.add('hidden');

    const views = ['dashboard', 'quizzes', 'questions', 'results', 'attendance', 'students', 'settings'];
    views.forEach(v => { const el = document.getElementById('view-' + v); if(el) el.classList.add('hidden'); });
    
    views.forEach(v => {
        const nav = document.getElementById('nav-' + v);
        if(nav) { nav.classList.remove('bg-blue-600', 'text-white'); nav.classList.add('text-slate-300', 'hover:bg-[#132A4A]', 'hover:text-white'); }
    });

    const activeView = document.getElementById('view-' + viewId);
    const activeNav = document.getElementById('nav-' + viewId);
    if(activeView) activeView.classList.remove('hidden');
    if(activeNav) {
        activeNav.classList.remove('text-slate-300', 'hover:bg-[#132A4A]', 'hover:text-white');
        activeNav.classList.add('bg-blue-600', 'text-white');
    }

    if (viewId === 'attendance') ipcRenderer.send('get-attendance', { instructor: getActiveInstructor() });

    if (viewId === 'settings') {
        updateAccountUI();
        applyRoleVisibility();
        if (isMasterAdmin()) ipcRenderer.send('get-admins', { requesterId: getAuthUser().id });
    }
}
    
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex'); 
    if (document.activeElement) document.activeElement.blur();
    setTimeout(() => {
        window.focus(); 
        const firstInput = modal.querySelector('input:not([type="hidden"]), textarea, select');
        if (firstInput) firstInput.focus();
    }, 150);
}

function closeModal(modalId) { 
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('hidden'); 
    modal.classList.remove('flex'); 
}

// --- INSTRUCTOR PROFILE SELECTOR ---

function updateActiveInstructorHeader() {
    const label = document.getElementById('header-active-instructor');
    if (!label) return;
    label.innerText = isMasterInstructorView() ? 'All Instructors' : getActiveInstructor();
}

function promptInstructorSelection() {
    openInstructorModal(true);
}

function openInstructorModal(forcePrompt = false) {
    if (forcePrompt && !subjectsLoaded) {
        pendingInstructorPrompt = true;
        return;
    }
    renderInstructorList();
    const closeBtn = document.getElementById('instructor-modal-close');
    if (closeBtn) closeBtn.classList.toggle('hidden', !!forcePrompt);
    openModal('modal-select-instructor');
}

function renderInstructorList() {
    const container = document.getElementById('instructor-list');
    if (!container) return;

    const active = getActiveInstructor();
    const isMasterActive = active === 'all';
    const masterUnlocked = canAccessInstructor('all');
    const activeClasses = 'border-blue-500 bg-blue-50 dark:bg-blue-900/20';
    const idleClasses = 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60';
    const checkIcon = `<i class="fa-solid fa-check text-blue-600 dark:text-blue-400 text-xs shrink-0"></i>`;
    const lockIcon = `<i class="fa-solid fa-lock text-amber-500 text-xs shrink-0" title="Password required"></i>`;

    let html = `
        <button type="button" onclick="selectInstructor('all')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${isMasterActive ? activeClasses : idleClasses}">
            <span class="w-8 h-8 rounded-md bg-slate-900 dark:bg-slate-700 text-white flex items-center justify-center shrink-0"><i class="fa-solid fa-layer-group text-xs"></i></span>
            <span class="flex-1 min-w-0">
                <span class="block text-sm font-semibold text-slate-800 dark:text-slate-100">All Instructors (Master View)</span>
                <span class="block text-xs text-slate-500 dark:text-slate-400">${masterUnlocked ? 'Full access to every subject, quiz, and result.' : 'Administrator password required to unlock.'}</span>
            </span>
            ${isMasterActive ? checkIcon : (masterUnlocked ? '' : lockIcon)}
        </button>`;

    const names = getProfileOptions();

    if (names.length === 0) {
        html += `<div class="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No instructor names found yet.<br>Add a subject or register an instructor account.
        </div>`;
    }

    names.forEach(name => {
        const subjectCount = allSubjects.filter(s => instructorNamesMatch(s.instructor_name, name)).length;
        const isActive = active === name;
        const unlocked = canAccessInstructor(name);
        const hasAccount = hasInstructorAccount(name);
        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part.charAt(0)).join('').toUpperCase() || '?';
        const status = `${subjectCount} subject${subjectCount === 1 ? '' : 's'}${hasAccount ? '' : ' · no account'}`;
        html += `
            <button type="button" onclick="selectInstructor('${escapeJsAttr(name)}')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${isActive ? activeClasses : idleClasses}">
                <span class="w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0 text-[11px] font-bold tracking-wide">${escapeHtml(initials)}</span>
                <span class="flex-1 min-w-0">
                    <span class="block text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">${escapeHtml(name)}</span>
                    <span class="block text-xs text-slate-500 dark:text-slate-400">${escapeHtml(status)}</span>
                </span>
                ${isActive ? checkIcon : (unlocked ? '' : lockIcon)}
            </button>`;
    });

    container.innerHTML = html;
}

// Alias used by data-load handlers.
function updateInstructorModal() {
    renderInstructorList();
}

function selectInstructor(name) {
    const normalized = (name === 'all') ? 'all' : normalizeInstructorName(name);
    if (!normalized) return;
    if (normalized !== 'all' && !hasInstructorAccount(normalized) && !isMasterAdmin() && !isOwnInstructorProfile(normalized)) {
        alert(`"${normalized}" has no registered instructor account yet. Ask the administrator to create one in Settings > Manage Admins.`);
        return;
    }
    if (canAccessInstructor(normalized)) {
        applyInstructorSelection(normalized);
    } else {
        requestInstructorAccess(normalized);
    }
}

function requestInstructorAccess(target) {
    pendingAccessTarget = target;
    const label = document.getElementById('instructor-access-target-name');
    if (label) label.innerText = target === 'all' ? 'the Master View' : target;
    const input = document.getElementById('instructor-access-password');
    if (input) input.value = '';
    const error = document.getElementById('instructor-access-error');
    if (error) { error.innerText = ''; error.classList.add('hidden'); }
    closeModal('modal-select-instructor');
    openModal('modal-instructor-access');
}

function cancelInstructorAccess() {
    pendingAccessTarget = null;
    closeModal('modal-instructor-access');
    if (!isMasterInstructorView() || !getUnlockedProfiles().length) {
        openInstructorModal(false);
    }
}

function submitInstructorAccess() {
    if (!pendingAccessTarget) return;
    const input = document.getElementById('instructor-access-password');
    const password = input ? input.value : '';
    if (!password) {
        const error = document.getElementById('instructor-access-error');
        if (error) { error.innerText = 'Please enter a password.'; error.classList.remove('hidden'); }
        return;
    }
    ipcRenderer.send('verify-instructor-access', { target: pendingAccessTarget, password });
}

ipcRenderer.on('verify-instructor-access-response', (event, response) => {
    const error = document.getElementById('instructor-access-error');
    if (response.success) {
        const target = pendingAccessTarget;
        pendingAccessTarget = null;
        if (target) rememberUnlockedProfile(target);
        closeModal('modal-instructor-access');
        if (target) applyInstructorSelection(target);
    } else if (error) {
        error.innerText = response.message || 'Incorrect password.';
        error.classList.remove('hidden');
        const input = document.getElementById('instructor-access-password');
        if (input) { input.value = ''; input.focus(); }
    }
});

function applyInstructorSelection(name) {
    const normalized = (name === 'all') ? 'all' : normalizeInstructorName(name);
    sessionStorage.setItem(INSTRUCTOR_STORAGE_KEY, normalized);
    closeModal('modal-select-instructor');
    closeModal('modal-instructor-access');
    updateActiveInstructorHeader();

    // Clear any loaded question-bank content so it cannot leak across profiles.
    currentLoadedQuestions = [];
    const questionsContainer = document.getElementById('questions-list-container');
    if (questionsContainer) {
        questionsContainer.innerHTML = `<div class="p-8 text-center text-slate-500 dark:text-slate-500 font-medium">Select a quiz from the dropdown menu to view or add questions.</div>`;
    }
    const questionCountBadge = document.getElementById('question-count-badge');
    if (questionCountBadge) questionCountBadge.innerText = '0 Questions';

    // Re-render every instructor-scoped surface from the cached datasets.
    renderSubjects();
    renderQuizManagement();
    renderStudents();
    if (allResults.length) renderResultsTable();
    renderAttendanceTable();

    const resultFilter = document.getElementById('result-filter-select');
    if (resultFilter) resultFilter.value = 'all';
    const quizFilter = document.getElementById('quiz-filter-select');
    if (quizFilter) quizFilter.value = 'all';

    filterQuizzes();
    filterResults();
    fetchDashboardStats();
    updateAccountUI();
    renderInstructorList();
}

function handleLogin() {
    const userBox = document.getElementById('login-username').value;
    const passBox = document.getElementById('login-password').value;
    ipcRenderer.send('login-request', { username: userBox, password: passBox });
}

ipcRenderer.on('login-response', (event, response) => {
    if (response.success) {
        const user = response.user || { id: 1, username: 'admin', displayName: 'Administrator', isAdmin: true };
        sessionStorage.setItem('role', 'admin');
        sessionStorage.setItem(AUTH_KEYS.id, user.id);
        sessionStorage.setItem(AUTH_KEYS.username, user.username);
        sessionStorage.setItem(AUTH_KEYS.displayName, user.displayName || user.username);
        sessionStorage.setItem(AUTH_KEYS.isAdmin, user.isAdmin ? 'true' : 'false');
        sessionStorage.removeItem(UNLOCKED_STORAGE_KEY);

        const activeProfile = user.isAdmin ? 'all' : (user.displayName || user.username);
        sessionStorage.setItem(INSTRUCTOR_STORAGE_KEY, activeProfile);

        const loginView = document.getElementById('view-login');
        loginView.style.display = 'none'; 
        document.getElementById('admin-layout').classList.remove('hidden');
        document.getElementById('view-student-portal').classList.add('hidden');
        switchView('dashboard');
        applyRoleVisibility();
        updateActiveInstructorHeader();
        updateAccountUI();
        renderInstructorList();
        ipcRenderer.send('get-instructor-profiles');

        if (user.isAdmin) {
            ipcRenderer.send('get-admins', { requesterId: user.id });
            promptInstructorSelection();
        } else {
            applyInstructorSelection(activeProfile);
        }
    } else {
        const loginBtn = document.querySelector('#login-form button[type="submit"]');
        const originalText = loginBtn.innerHTML;
        loginBtn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Invalid Credentials`;
        loginBtn.classList.replace('bg-blue-600', 'bg-red-600');
        loginBtn.classList.replace('hover:bg-blue-700', 'hover:bg-red-700');

        const userBox = document.getElementById('login-username');
        const passBox = document.getElementById('login-password');
        userBox.value = ''; passBox.value = ''; userBox.focus();

        setTimeout(() => {
            loginBtn.innerHTML = originalText;
            loginBtn.classList.replace('bg-red-600', 'bg-blue-600');
            loginBtn.classList.replace('hover:bg-red-700', 'hover:bg-blue-700');
        }, 2500);
    }
});

function logoutToLogin() {
    sessionStorage.clear(); 
    updateActiveInstructorHeader();

    // Clear account fields so the next login starts clean.
    ['account-old-pass', 'account-new-pass', 'account-confirm-pass'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['account-username', 'account-profile'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = '-';
    });
    const adminsBody = document.getElementById('admins-table-body');
    if (adminsBody) adminsBody.innerHTML = '';
    adminAccounts = [];
    revealedAdminPasswords = new Set();

    const loginView = document.getElementById('view-login');
    loginView.style.display = 'flex'; 
    document.getElementById('admin-layout').classList.add('hidden');
    document.getElementById('view-student-portal').classList.add('hidden');
    document.getElementById('view-take-quiz').classList.add('hidden');
    applyRoleVisibility();

    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    const studentIdEl = document.getElementById('student-id-input');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    if (studentIdEl) studentIdEl.value = '';

    if (document.activeElement) document.activeElement.blur();
    setTimeout(() => {
        window.focus(); 
        if (userEl) userEl.focus();
    }, 150);
}

// --- ROLE-AWARE UI ---

function applyRoleVisibility() {
    const admin = isMasterAdmin();
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !admin);
    });
    const badge = document.getElementById('account-role-badge');
    if (badge) {
        badge.innerText = admin ? 'Master Admin' : 'Instructor';
        badge.className = admin
            ? 'text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
            : 'text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400';
    }
}

function updateAccountUI() {
    const auth = getAuthUser();
    const usernameEl = document.getElementById('account-username');
    const profileEl = document.getElementById('account-profile');
    if (usernameEl) usernameEl.innerText = auth.username || '-';
    if (profileEl) profileEl.innerText = isMasterInstructorView() ? 'All Instructors' : getActiveInstructor();
    applyRoleVisibility();
}

function changeOwnPassword() {
    const auth = getAuthUser();
    if (!auth.id) { alert('You must be signed in to change your password.'); return; }

    const oldPass = document.getElementById('account-old-pass').value;
    const newPass = document.getElementById('account-new-pass').value;
    const confirmPass = document.getElementById('account-confirm-pass').value;

    if (!oldPass || !newPass) { alert('Please enter your current and new password.'); return; }
    if (newPass !== confirmPass) { alert('The new passwords do not match.'); return; }
    if (newPass.length < 3) { alert('The new password must be at least 3 characters long.'); return; }

    ipcRenderer.send('change-password', { userId: auth.id, oldPassword: oldPass, newPassword: newPass });
}

ipcRenderer.on('password-change-response', (event, response) => {
    if (response.success) {
        ['account-old-pass', 'account-new-pass', 'account-confirm-pass'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    }
    alert(response.message || (response.success ? 'Password updated successfully.' : 'Could not update the password.'));
});

// --- INSTRUCTOR PROFILES (safe list) ---

ipcRenderer.on('load-instructor-profiles', (event, data) => {
    instructorProfileNames = (data && data.names) || [];
    instructorAccounts = (data && data.accounts) || [];

    const datalist = document.getElementById('instructor-name-options');
    if (datalist) {
        datalist.innerHTML = getProfileOptions().map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
    }

    renderInstructorList();
    populateRegistrarSelects();
});

// --- SUBJECT MANAGEMENT ---

let currentEditSubjectId = null;

ipcRenderer.on('load-subjects', (event, subjects) => {
    allSubjects = subjects || [];
    subjectsLoaded = true;
    renderSubjects();
    renderQuizManagement();
    if (allResults.length) renderResultsTable();
    updateInstructorModal();
    updateActiveInstructorHeader();

    if (pendingInstructorPrompt) {
        pendingInstructorPrompt = false;
        openInstructorModal(true);
    }
    ipcRenderer.send('get-instructor-profiles');
});

function renderSubjects() {
    const scopedSubjects = getScopedSubjects();
    const quizDropdown = document.getElementById('quiz-subject');
    const filterDropdown = document.getElementById('quiz-filter-select');
    const manageTable = document.getElementById('manage-subjects-tbody');

    if (quizDropdown) quizDropdown.innerHTML = '<option value="" disabled selected>Select a subject...</option>';
    if (filterDropdown) filterDropdown.innerHTML = '<option value="all">All Subjects</option>';
    if (manageTable) manageTable.innerHTML = ''; 

    if (scopedSubjects.length === 0 && manageTable) {
        const emptyMsg = isMasterInstructorView()
            ? 'No subjects found.'
            : 'No subjects are assigned to this instructor yet.';
        manageTable.innerHTML = `<tr><td colspan="3" class="px-4 py-6 text-center text-slate-500 dark:text-slate-400 text-sm">${emptyMsg}</td></tr>`;
    }

    scopedSubjects.forEach(subject => {
        if (quizDropdown) quizDropdown.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(subject.subject_name)}">${escapeHtml(subject.subject_name)} (Instructor: ${escapeHtml(subject.instructor_name)})</option>`);
        if (filterDropdown) filterDropdown.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(subject.subject_name)}">${escapeHtml(subject.subject_name)}</option>`);
        if (manageTable) {
            manageTable.insertAdjacentHTML('beforeend', `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td class="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(subject.subject_name)}</td>
                    <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400">${escapeHtml(subject.instructor_name)}</td>
                    <td class="px-4 py-2.5 text-center space-x-2">
                        <button onclick="prepareEditSubject(${subject.id}, '${escapeJsAttr(subject.subject_name)}', '${escapeJsAttr(subject.instructor_name)}')" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:border-blue-700 dark:hover:text-blue-300 transition-colors" title="Edit Subject"><i class="fa-solid fa-pen text-[10px]"></i></button>
                        <button onclick="deleteSubject(${subject.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-50 hover:border-red-300 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:border-red-700 dark:hover:text-red-300 transition-colors" title="Delete Subject"><i class="fa-solid fa-trash text-[10px]"></i></button>
                    </td>
                </tr>
            `);
        }
    });
}

function openAddSubjectModal() { closeModal('modal-manage-subjects'); currentEditSubjectId = null; document.getElementById('new-subject-name').value = ''; document.getElementById('new-subject-instructor').value = isMasterInstructorView() ? '' : getActiveInstructor(); openModal('modal-add-subject'); }
function openManageSubjectsModal() { openModal('modal-manage-subjects'); }

function prepareEditSubject(id, name, instructor) {
    closeModal('modal-manage-subjects'); currentEditSubjectId = id; 
    document.getElementById('new-subject-name').value = name;
    document.getElementById('new-subject-instructor').value = instructor;
    openModal('modal-add-subject'); 
}

function deleteSubject(id) { customConfirm("Are you sure you want to delete this subject?", () => ipcRenderer.send('delete-subject', id)); }

function saveNewSubjectUI() {
    const subName = document.getElementById('new-subject-name').value.trim();
    const instName = document.getElementById('new-subject-instructor').value.trim();

    if (!subName || !instName) { alert("Please fill in both fields!"); return; }

    if (currentEditSubjectId) {
        ipcRenderer.send('update-subject', { id: currentEditSubjectId, subject_name: subName, instructor_name: instName });
        alert(`Success! Subject updated.`);
    } else {
        ipcRenderer.send('add-subject', { subject_name: subName, instructor_name: instName });
        alert(`Success! ${subName} has been added.`);
    }

    document.getElementById('new-subject-name').value = '';
    document.getElementById('new-subject-instructor').value = '';
    closeModal('modal-add-subject');
}

// --- QUIZ MANAGEMENT ---

ipcRenderer.on('load-quizzes', (event, quizzes) => {
    allQuizzes = quizzes || [];
    renderQuizManagement();
    if (allResults.length) renderResultsTable();
    if (allAttendance.length) renderAttendanceTable();
});

function renderQuizManagement() {
    // Instructor-scoped dataset: only quizzes whose subject belongs to the active instructor.
    const quizzes = (allQuizzes || []).filter(quizBelongsToActiveInstructor);
    const tableBody = document.getElementById('quiz-table-body');
    const questionQuizSelect = document.getElementById('question-quiz-select');
    
    let currentSelected = null;
    if (questionQuizSelect) currentSelected = questionQuizSelect.value;
    
    if (questionQuizSelect) {
        questionQuizSelect.innerHTML = '<option value="" disabled selected>Select a quiz to manage...</option>';
        quizzes.forEach(quiz => questionQuizSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(quiz.title)}">${escapeHtml(quiz.title)}</option>`));
        
        if (currentSelected && quizzes.find(q => q.title === currentSelected)) {
            questionQuizSelect.value = currentSelected;
        } else {
            ['btn-smart-paste', 'btn-word-import', 'btn-excel-import', 'btn-clear-questions', 'btn-add-question', 'btn-print-exam', 'btn-recover-questions'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.disabled = true;
                    btn.className = btn.id === 'btn-clear-questions' ? 'btn btn-danger' : 'btn btn-secondary';
                }
            });
        }
    }

    const resultFilterSelect = document.getElementById('result-filter-select');
    if (resultFilterSelect) {
        const currentResultFilter = resultFilterSelect.value;
        resultFilterSelect.innerHTML = '<option value="all">All Quizzes</option>';
        quizzes.forEach(quiz => resultFilterSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(quiz.title)}">${escapeHtml(quiz.title)}</option>`));
        if (currentResultFilter && quizzes.find(q => q.title === currentResultFilter)) resultFilterSelect.value = currentResultFilter;
    }

    if (!tableBody) return; 
    tableBody.innerHTML = ''; 

    if (quizzes.length === 0) {
        const emptyMsg = isMasterInstructorView()
            ? 'No quizzes found. Click "Create Quiz" to get started.'
            : 'No quizzes found for this instructor yet.';
        tableBody.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400 text-sm">${emptyMsg}</td></tr>`;
        filterQuizzes();
        return;
    }

    quizzes.forEach(quiz => {
        const lockIcon = quiz.passcode ? `<i class="fa-solid fa-lock text-red-500 ml-1" title="Passcode Required"></i>` : '';
        const safeTitle = escapeJsAttr(quiz.title);
        const safeSubject = escapeJsAttr(quiz.subject);
        const safePasscode = quiz.passcode ? escapeJsAttr(quiz.passcode) : '';
        const safeTargetSection = quiz.target_section ? escapeJsAttr(quiz.target_section) : 'All Sections';
        
        const tabLimit = quiz.tab_limit !== null && quiz.tab_limit !== undefined ? quiz.tab_limit : 3;
        const passingRate = quiz.passing_rate !== null && quiz.passing_rate !== undefined ? quiz.passing_rate : 50;
        const safeIdleLimit = quiz.idle_time_limit !== null && quiz.idle_time_limit !== undefined ? quiz.idle_time_limit : 0;
        const safeQuestionTimeLimit = quiz.question_time_limit !== null && quiz.question_time_limit !== undefined ? quiz.question_time_limit : 0;
        const safeRequireCamera = quiz.require_camera === 1 || quiz.require_camera === true ? 1 : 0;

        const isArchived = quiz.is_archived === 1;
        
        const archiveBtn = !isArchived 
            ? `<button onclick="toggleArchive(${quiz.id}, 1)" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700 dark:hover:bg-amber-900/40 dark:hover:border-amber-700 dark:hover:text-amber-300 transition-colors" title="Archive Quiz"><i class="fa-solid fa-box-archive text-[10px]"></i></button>`
            : `<button onclick="toggleArchive(${quiz.id}, 0)" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700 dark:hover:bg-emerald-900/40 dark:hover:border-emerald-700 dark:hover:text-emerald-300 transition-colors" title="Restore Quiz"><i class="fa-solid fa-box-open text-[10px]"></i></button>`;
            
        const statusBadge = !isArchived
            ? `<span class="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border border-blue-200 dark:border-blue-800/50">Active</span>`
            : `<span class="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border border-slate-200 dark:border-slate-700">Archived</span>`;

        const titleClass = isArchived ? "text-slate-500 dark:text-slate-500 line-through" : "text-slate-800 dark:text-slate-200";

        tableBody.insertAdjacentHTML('beforeend', `
            <tr data-subject="${escapeHtml(quiz.subject)}" class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <td class="px-4 py-2.5">
                    <p class="font-medium ${titleClass}">${escapeHtml(quiz.title)} ${lockIcon}</p>
                    <p class="text-[11px] text-slate-500 dark:text-slate-500 mt-0.5"><i class="fa-solid fa-users text-slate-400 dark:text-slate-600 mr-1"></i>${escapeHtml(quiz.target_section || 'All Sections')}</p>
                </td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400">${escapeHtml(quiz.subject)}</td>
                <td class="px-4 py-2.5 text-center font-semibold text-slate-700 dark:text-slate-300">
                    <span class="text-blue-600 dark:text-blue-400">${quiz.uploaded_count}</span> <span class="text-slate-400 dark:text-slate-500 text-xs">/ ${quiz.items}</span>
                </td>
                <td class="px-4 py-2.5">${statusBadge}</td>
                <td class="px-4 py-2.5 text-center space-x-1.5 whitespace-nowrap">
                    <button onclick="jumpToQuestionBank('${safeTitle}')" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700 dark:hover:bg-emerald-900/40 dark:hover:border-emerald-700 dark:hover:text-emerald-300 transition-colors" title="Manage Questions"><i class="fa-solid fa-list-check text-[10px]"></i></button>
                    <button onclick="prepareEditQuiz(${quiz.id}, '${safeTitle}', '${safeSubject}', ${quiz.items}, ${quiz.time_limit || 0}, '${safePasscode}', ${tabLimit}, ${passingRate}, '${safeTargetSection}', ${safeIdleLimit}, ${safeQuestionTimeLimit}, ${safeRequireCamera})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:border-blue-700 dark:hover:text-blue-300 transition-colors" title="Edit Quiz"><i class="fa-solid fa-pen text-[10px]"></i></button>
                    ${archiveBtn}
                    <button onclick="deleteQuiz(${quiz.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-50 hover:border-red-300 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:border-red-700 dark:hover:text-red-300 transition-colors" title="Permanently Delete Quiz"><i class="fa-solid fa-trash text-[10px]"></i></button>
                </td>
            </tr>
        `);
    });

    filterQuizzes();
}

let currentEditQuizId = null;

function openCreateQuizModal() {
    currentEditQuizId = null; 
    document.getElementById('quiz-title').value = '';
    document.getElementById('quiz-subject').value = '';
    document.getElementById('quiz-items').value = '';
    
    const passcodeBox = document.getElementById('quiz-passcode');
    if (passcodeBox) passcodeBox.value = '';
    const timeLimitBox = document.getElementById('quiz-time-limit');
    if (timeLimitBox) timeLimitBox.value = ''; 

    document.getElementById('quiz-passing-rate').value = '50';
    document.getElementById('quiz-tab-limit').value = '3';
    document.getElementById('quiz-target-section').value = '';
    document.getElementById('quiz-idle-limit').value = '0'; 
    document.getElementById('quiz-question-time-limit').value = '0';
    document.getElementById('quiz-require-camera').checked = false;
    const customInstructionsBox = document.getElementById('quiz-custom-instructions');
    if (customInstructionsBox) customInstructionsBox.value = '';

    document.getElementById('modal-title-text').innerHTML = `<i class="fa-solid fa-file-circle-plus text-blue-400"></i> Create New Quiz`;
    document.getElementById('modal-save-btn').innerText = 'Save Quiz';
    openModal('modal-create-quiz'); 
}

function prepareEditQuiz(id, currentTitle, currentSubject, currentItems, currentTimeLimit, currentPasscode, currentTabLimit, currentPassingRate, currentTargetSection, currentIdleLimit, currentQuestionTimeLimit, currentRequireCamera) {
    currentEditQuizId = id; 
    document.getElementById('quiz-title').value = currentTitle;
    document.getElementById('quiz-subject').value = currentSubject;
    document.getElementById('quiz-items').value = currentItems;
    
    const passcodeBox = document.getElementById('quiz-passcode');
    if (passcodeBox) passcodeBox.value = currentPasscode || '';
    
    const timeLimitBox = document.getElementById('quiz-time-limit');

    if (timeLimitBox) {
        if (currentTimeLimit > 0) {
            if (currentTimeLimit >= 60) {
                const h = Math.floor(currentTimeLimit / 60);
                const m = currentTimeLimit % 60;
                timeLimitBox.value = `${h}:${m.toString().padStart(2, '0')}`;
            } else {
                timeLimitBox.value = currentTimeLimit;
            }
        } else {
            timeLimitBox.value = '';
        }
    }

    document.getElementById('quiz-passing-rate').value = currentPassingRate || 50; 
    document.getElementById('quiz-tab-limit').value = currentTabLimit !== undefined ? currentTabLimit : 3;
    document.getElementById('quiz-target-section').value = currentTargetSection !== 'All Sections' ? currentTargetSection : '';
    
    const idleBox = document.getElementById('quiz-idle-limit');
    if (idleBox) idleBox.value = currentIdleLimit !== undefined ? currentIdleLimit : 0;

    const questionTimeBox = document.getElementById('quiz-question-time-limit');
    if (questionTimeBox) questionTimeBox.value = currentQuestionTimeLimit !== undefined ? currentQuestionTimeLimit : 0;

    const requireCameraBox = document.getElementById('quiz-require-camera');
    if (requireCameraBox) requireCameraBox.checked = currentRequireCamera === 1 || currentRequireCamera === true;

    const editingQuiz = (allQuizzes || []).find(q => q.id === id);
    const customInstructionsBox = document.getElementById('quiz-custom-instructions');
    if (customInstructionsBox) customInstructionsBox.value = editingQuiz ? (editingQuiz.custom_instructions || '') : '';

    document.getElementById('modal-title-text').innerHTML = `<i class="fa-solid fa-pen text-blue-400"></i> Edit Quiz`;
    document.getElementById('modal-save-btn').innerText = 'Update Quiz';
    openModal('modal-create-quiz'); 
}

function saveNewQuiz() {
    const titleBox = document.getElementById('quiz-title').value.trim();
    const subjectBox = document.getElementById('quiz-subject').value;
    const itemsBox = document.getElementById('quiz-items').value;
    
    const passcodeEl = document.getElementById('quiz-passcode');
    const passcodeBox = passcodeEl ? passcodeEl.value.trim() : '';
    
    const timeLimitEl = document.getElementById('quiz-time-limit');
    const timeLimitBox = timeLimitEl ? timeLimitEl.value.trim() : ''; 

    let passing_rate = parseInt(document.getElementById('quiz-passing-rate').value);
    if (isNaN(passing_rate)) passing_rate = 50;
    
    let tab_limit = parseInt(document.getElementById('quiz-tab-limit').value);
    if (isNaN(tab_limit)) tab_limit = 3;

    let target_section = document.getElementById('quiz-target-section').value.trim();
    if (!target_section) target_section = 'All Sections';

    let idle_limit = parseInt(document.getElementById('quiz-idle-limit').value);
    if (isNaN(idle_limit) || idle_limit < 0) idle_limit = 0;

    let question_time_limit = parseInt(document.getElementById('quiz-question-time-limit').value);
    if (isNaN(question_time_limit) || question_time_limit < 0) question_time_limit = 0;

    let require_camera = document.getElementById('quiz-require-camera').checked ? 1 : 0;

    const customInstructionsEl = document.getElementById('quiz-custom-instructions');
    const customInstructions = customInstructionsEl ? customInstructionsEl.value.trim() : '';

    if (!titleBox || !subjectBox || !itemsBox) {
        alert("Please fill in all required fields!");
        return;
    }

    const parsedItems = parseInt(itemsBox);
    if (parsedItems <= 0 || isNaN(parsedItems)) {
        const itemsInput = document.getElementById('quiz-items'); 
        if (itemsInput) {
            itemsInput.style.border = "2px solid red";
            itemsInput.style.backgroundColor = "#ffe6e6"; 
            itemsInput.value = "";
            itemsInput.placeholder = "Please enter a valid number";
            itemsInput.addEventListener('focus', function() {
                this.style.border = ""; this.style.backgroundColor = ""; this.placeholder = "";
            }, { once: true }); 
        }
        return; 
    }

    let finalTimeLimitInMinutes = 0;
    if (timeLimitBox) {
        if (timeLimitBox.includes(':')) {
            const parts = timeLimitBox.split(':');
            const h = parseInt(parts[0]) || 0;
            const m = parseInt(parts[1]) || 0;
            finalTimeLimitInMinutes = (h * 60) + m;
        } else {
            finalTimeLimitInMinutes = parseInt(timeLimitBox) || 0;
        }
    }

    if (currentEditQuizId) {
        ipcRenderer.send('update-quiz', { 
            id: currentEditQuizId, 
            title: titleBox, 
            subject: subjectBox, 
            items: parsedItems, 
            time_limit: finalTimeLimitInMinutes, 
            passcode: passcodeBox,
            tab_limit: tab_limit,
            passing_rate: passing_rate,
            idle_time_limit: idle_limit,
            question_time_limit: question_time_limit,
            require_camera: require_camera,
            target_section: target_section,
            custom_instructions: customInstructions
        });
    } else {
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        ipcRenderer.send('add-quiz', { 
            title: titleBox, 
            subject: subjectBox, 
            items: parsedItems, 
            time_limit: finalTimeLimitInMinutes, 
            date_created: today, 
            passcode: passcodeBox,
            tab_limit: tab_limit,
            passing_rate: passing_rate,
            idle_time_limit: idle_limit,
            question_time_limit: question_time_limit,
            require_camera: require_camera,
            target_section: target_section,
            custom_instructions: customInstructions
        });
    }

    document.getElementById('modal-create-quiz').classList.add('hidden');
}

function toggleArchive(quizId, status) {
    const msg = status === 1 
        ? "Are you sure you want to Archive this exam? It will be hidden from students, but you won't lose your questions." 
        : "Are you sure you want to Restore this exam? It will become visible to students again.";
        
    customConfirm(msg, () => {
        ipcRenderer.send('toggle-archive-quiz', { id: quizId, is_archived: status });
    });
}

function deleteQuiz(quizId) {
    customConfirm("WARNING: Are you sure you want to completely DELETE this quiz? Use 'Archive' instead if you want to reuse it later.", () => ipcRenderer.send('delete-quiz', quizId));
}

// --- STUDENT DESKTOP LOGIN/PORTAL ---

function openStudentPortal() {
    const studentIdBox = document.getElementById('student-id-input').value.trim();
    if (!studentIdBox) { alert("Please enter your Student ID."); return; }
    ipcRenderer.send('student-login-request', studentIdBox);
}

ipcRenderer.on('student-login-response', (event, response) => {
    if (response.success) {
        sessionStorage.setItem('role', 'student'); 
        const portalAdminBtn = document.getElementById('portal-admin-return-btn');
        if (portalAdminBtn) portalAdminBtn.classList.add('hidden');
        document.getElementById('view-login').style.display = 'none';
        document.getElementById('view-student-portal').classList.remove('hidden');
        document.getElementById('portal-student-name').innerText = response.student.full_name;
        document.getElementById('portal-student-course').innerText = response.student.course_section;
        currentDesktopStudentId = response.student.student_id || '';
        ipcRenderer.send('get-student-quizzes', { studentId: currentDesktopStudentId });
    } else {
        alert("Student ID not found. Please ask your instructor to register you.");
    }
});

ipcRenderer.on('load-student-quizzes', (event, quizzes) => {
    const container = document.querySelector('#view-student-portal .grid');
    if (!container) return;
    
    // v2.1.4: the server already scopes this list by roster, section and instructor.
    const visibleQuizzes = Array.isArray(quizzes) ? quizzes : [];

    container.innerHTML = ''; 

    const filterSelect = document.getElementById('desktop-student-subject-filter');
    if (filterSelect) {
        filterSelect.innerHTML = '<option value="all">All Subjects</option>';
        const uniqueSubjects = [...new Set(visibleQuizzes.map(q => q.subject))];
        uniqueSubjects.forEach(sub => {
            filterSelect.insertAdjacentHTML('beforeend', `<option value="${sub}">${sub}</option>`);
        });
    }

    if (visibleQuizzes.length === 0) {
        container.innerHTML = `<div class="col-span-full p-8 text-center text-slate-500">No quizzes are currently available for your section.</div>`;
        return;
    }

    visibleQuizzes.forEach(quiz => {
        const colors = ['blue', 'green', 'purple', 'orange', 'teal'];
        const color = colors[quiz.id % colors.length];
        const timerBadge = quiz.time_limit > 0 ? `<i class="fa-regular fa-clock"></i> ${quiz.time_limit} Mins` : `<i class="fa-solid fa-infinity"></i> Untimed`;
        
        const lockIcon = quiz.passcode ? `<i class="fa-solid fa-lock text-red-500 ml-1" title="Passcode Required"></i>` : '';
        const actualItems = Math.min(quiz.items, quiz.uploaded_count);

        container.insertAdjacentHTML('beforeend', `
            <div class="desktop-student-quiz-card bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-6 hover:shadow-md transition-shadow border-t-4 border-t-${color}-500 flex flex-col" data-subject="${quiz.subject}">
                <div class="flex justify-between items-start mb-4">
                    <span class="bg-${color}-100 dark:bg-${color}-900/30 text-${color}-700 dark:text-${color}-400 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider">${quiz.subject}</span>
                    <span class="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1">${timerBadge}</span>
                </div>
                <h3 class="text-lg font-bold text-slate-800 dark:text-slate-100 mb-1">${quiz.title} ${lockIcon}</h3>
                <p class="text-xs text-slate-500 dark:text-slate-500 mb-6">Make sure you have a stable connection before starting.</p>
                <div class="mt-auto border-t border-slate-100 dark:border-slate-800 pt-4 flex items-center justify-between">
                    <div class="text-center">
                        <p class="text-[10px] text-slate-400 font-bold uppercase">Items</p>
                        <p class="text-lg font-extrabold text-slate-700 dark:text-slate-200">${actualItems}</p>
                    </div>
                    <button type="button" onclick="attemptQuiz('${quiz.title.replace(/'/g, "\\'")}', ${quiz.time_limit || 0}, '${quiz.passcode || ''}')" class="bg-${color}-600 hover:bg-${color}-700 text-white px-6 py-2 rounded-lg text-sm font-bold transition-colors shadow-sm">Start Quiz</button>
                </div>
            </div>
        `);
    });
});

let pendingQuizTitle = "";
let pendingQuizTime = 0;
let expectedPasscode = "";

function attemptQuiz(title, timeLimit, passcode) {
    if (!passcode) {
        startQuiz(title, timeLimit); 
    } else {
        pendingQuizTitle = title;
        pendingQuizTime = timeLimit;
        expectedPasscode = passcode;
        document.getElementById('student-passcode-input').value = '';
        openModal('modal-enter-passcode');
    }
}

function verifyPasscode() {
    const input = document.getElementById('student-passcode-input').value.trim();
    if (input === expectedPasscode) {
        closeModal('modal-enter-passcode');
        startQuiz(pendingQuizTitle, pendingQuizTime);
    } else {
        alert("Incorrect PIN! Please ask your instructor for the code.");
        document.getElementById('student-passcode-input').value = '';
    }
}

// --- STUDENT MANAGEMENT ---

function importStudentsCSV() {
    closeModal('modal-import-students');
    const auth = getAuthUser();
    let registrar = isMasterAdmin()
        ? (isMasterInstructorView() ? '' : getActiveInstructor())
        : (normalizeInstructorName(auth.displayName) || getActiveInstructor());
    if (registrar === 'all') registrar = '';
    ipcRenderer.send('import-students-csv', { registered_by: registrar });
}

function registrarOptionsHtml(selected) {
    const target = normalizeInstructorName(selected);
    const options = [];
    if (isMasterInstructorView()) {
        options.push(`<option value="" ${target ? '' : 'selected'}>Unassigned (Master View only)</option>`);
    }
    let matched = false;
    getProfileOptions().forEach(name => {
        const isSelected = instructorNamesMatch(name, target);
        if (isSelected) matched = true;
        options.push(`<option value="${escapeHtml(name)}" ${isSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`);
    });
    if (target && !matched) {
        options.push(`<option value="${escapeHtml(target)}" selected>${escapeHtml(target)}</option>`);
    }
    return options.join('');
}

function populateRegistrarSelects() {
    const active = getActiveInstructor();
    const auth = getAuthUser();
    const ownProfile = normalizeInstructorName(auth.displayName) || active;
    const defaultRegistrar = isMasterAdmin()
        ? (isMasterInstructorView() ? '' : active)
        : (ownProfile === 'all' ? '' : ownProfile);

    const createSelect = document.getElementById('reg-student-registrar');
    const editSelect = document.getElementById('edit-student-registrar');
    if (createSelect) createSelect.innerHTML = registrarOptionsHtml(defaultRegistrar);
    if (editSelect && !editSelect.dataset.current) editSelect.innerHTML = registrarOptionsHtml(defaultRegistrar);

    const createWrap = document.getElementById('reg-student-registrar-wrap');
    const editWrap = document.getElementById('edit-student-registrar-wrap');
    if (createWrap) createWrap.classList.toggle('hidden', !isMasterAdmin() && !isMasterInstructorView());
    if (editWrap) editWrap.classList.toggle('hidden', !isMasterAdmin());
}

function openCreateStudentModal() {
    document.getElementById('reg-student-id').value = '';
    document.getElementById('reg-student-name').value = '';
    document.getElementById('reg-student-course').value = '';
    populateRegistrarSelects();
    openModal('modal-create-student');
}

ipcRenderer.on('student-add-response', (event, response) => {
    if (response.success) {
        closeModal('modal-create-student');
        document.getElementById('reg-student-id').value = '';
        document.getElementById('reg-student-name').value = '';
    } else { alert(response.message); }
});

function saveNewStudent() {
    const idBox = document.getElementById('reg-student-id').value.trim();
    const nameBox = document.getElementById('reg-student-name').value.trim();
    const courseBox = document.getElementById('reg-student-course').value;

    if (!idBox || !nameBox || !courseBox) { alert("Please fill in all fields!"); return; }

    const registrarSelect = document.getElementById('reg-student-registrar');
    let registrar = isMasterInstructorView() ? '' : getActiveInstructor();
    if (registrarSelect) registrar = registrarSelect.value;

    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    ipcRenderer.send('add-student', { student_id: idBox, full_name: nameBox, course_section: courseBox, date_registered: today, registered_by: registrar });
}

function renderStudents() {
    const tableBody = document.getElementById('student-table-body');
    if (!tableBody) return;

    const scoped = isMasterInstructorView()
        ? (allStudents || [])
        : (allStudents || []).filter(s => normalizeInstructorName(s.registered_by).toLowerCase() === getActiveInstructor().toLowerCase());

    if (scoped.length === 0) {
        const message = isMasterInstructorView()
            ? 'No students registered yet.'
            : 'No students registered by this instructor yet.';
        tableBody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500 font-medium">${message}</td></tr>`;
        filterStudentTable();
        return;
    }

    tableBody.innerHTML = scoped.map(student => {
        const safeId = escapeJsAttr(student.student_id);
        const safeName = escapeJsAttr(student.full_name);
        const safeCourse = escapeJsAttr(student.course_section);
        const safeRegistrar = escapeJsAttr(student.registered_by || '');
        const registrarLabel = normalizeInstructorName(student.registered_by)
            ? escapeHtml(student.registered_by)
            : '<span class="text-slate-400 dark:text-slate-500">Unassigned</span>';

        return `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <td class="px-4 py-2.5 font-medium text-blue-600 dark:text-blue-400">${escapeHtml(student.student_id)}</td>
                <td class="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(student.full_name)}</td>
                <td class="px-4 py-2.5 text-slate-600 dark:text-slate-400">${escapeHtml(student.course_section)}</td>
                <td class="px-4 py-2.5 text-slate-600 dark:text-slate-400 text-xs">${registrarLabel}</td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-500 text-xs">${escapeHtml(student.date_registered)}</td>
                <td class="px-4 py-2.5 text-center space-x-1.5 whitespace-nowrap">
                    <button type="button" onclick="prepareEditStudent(${student.id}, '${safeId}', '${safeName}', '${safeCourse}', '${safeRegistrar}')" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:border-blue-700 dark:hover:text-blue-300 transition-colors" title="Edit Student"><i class="fa-solid fa-pen text-[10px]"></i></button>
                    <button type="button" onclick="deleteStudent(${student.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-50 hover:border-red-300 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:border-red-700 dark:hover:text-red-300 transition-colors" title="Delete Student"><i class="fa-solid fa-trash text-[10px]"></i></button>
                </td>
            </tr>`;
    }).join('');

    filterStudentTable();
}

// Batch 1: real-time client-side search for the Student Directory.
function filterStudentTable() {
    const input = document.getElementById('search-student');
    const term = input ? input.value.toLowerCase().trim() : '';
    const rows = document.querySelectorAll('#student-table-body tr');
    let visible = 0;

    rows.forEach(row => {
        if (row.cells.length < 2) return;
        const studentId = String(row.cells[0].textContent || '').toLowerCase();
        const studentName = String(row.cells[1].textContent || '').toLowerCase();
        const matches = !term || studentId.includes(term) || studentName.includes(term);
        row.style.display = matches ? '' : 'none';
        if (matches) visible++;
    });

    const countEl = document.getElementById('student-count');
    if (countEl) countEl.innerText = `${visible} student${visible === 1 ? '' : 's'}`;
}

ipcRenderer.on('load-students', (event, students) => {
    allStudents = students || [];
    renderStudents();
});

function deleteStudent(id) { customConfirm("Are you sure you want to remove this student?", () => ipcRenderer.send('delete-student', id)); }

// --- SMART IMPORT ENGINE (Handles Paste and Word Docs) ---

function processBulkImport() {
    const rawText = document.getElementById('bulk-paste-input').value;
    const selectedQuiz = document.getElementById('question-quiz-select').value;

    if (!selectedQuiz) { alert("Hold on! Please select a quiz from the dropdown menu first."); return; }
    if (!rawText.trim()) { alert("Please paste some questions first!"); return; }

    parseAndSaveQuestions(rawText, selectedQuiz);
    
    document.getElementById('bulk-paste-input').value = '';
    closeModal('modal-bulk-import');
}

function triggerWordImport() {
    const selectedQuiz = document.getElementById('question-quiz-select').value;
    if (!selectedQuiz) { alert("Hold on! Please select a quiz from the dropdown menu first."); return; }
    
    ipcRenderer.send('import-word-questions', selectedQuiz);
    closeModal('modal-word-import');
}

function triggerExcelImport() {
    const selectedQuiz = document.getElementById('question-quiz-select').value;
    if (!selectedQuiz) { alert("Hold on! Please select a quiz from the dropdown menu first."); return; }

    ipcRenderer.send('import-excel-questions', selectedQuiz);
}

// Convert Mammoth's marked-up HTML back into plain text while preserving
// red/highlighted correct answers as asterisks for the smart parser.
function htmlColorIsRed(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return false;
    if (/^red$/.test(raw)) return true;

    const rgbMatch = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
        const r = Number(rgbMatch[1]);
        const g = Number(rgbMatch[2]);
        const b = Number(rgbMatch[3]);
        return r >= 150 && g <= 110 && b <= 110;
    }

    const hex = raw.replace(/[^0-9a-f]/g, '');
    if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if (![r, g, b].every(Number.isFinite)) return false;
        return r >= 150 && g <= 110 && b <= 110;
    }
    return false;
}

function htmlTagIsMarked(attrs) {
    const lower = String(attrs || '').toLowerCase();
    if (/correct-answer|\bcorrect\b|\bhighlight(?:ed)?\b|\bred\b|\.red\b/.test(lower)) return true;

    const styleMatch = lower.match(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const style = styleMatch ? (styleMatch[1] || styleMatch[2] || '') : '';
    if (style) {
        const colorMatch = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
        if (colorMatch && htmlColorIsRed(colorMatch[1])) return true;

        const backgroundMatch = style.match(/background(?:-color)?\s*:\s*([^;]+)/i);
        if (backgroundMatch && !/^(?:transparent|none|white|#fff(?:fff)?)$/i.test(backgroundMatch[1].trim())) return true;
    }
    return false;
}

function htmlToMarkedText(html) {
    if (!html) return '';

    let output = String(html);

    // Convert marked containers into *...* so the existing asterisk parser can see them.
    for (let pass = 0; pass < 2; pass++) {
        output = output.replace(/<mark\b([^>]*)>([\s\S]*?)<\/mark>/gi, (match, attrs, inner) => '*' + inner + '*');
        output = output.replace(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi, (match, attrs, inner) => {
            return htmlTagIsMarked(attrs) ? '*' + inner + '*' : match;
        });
    }

    output = output.replace(/<br\s*\/?>/gi, '\n');
    output = output.replace(/<\/(?:p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n');
    output = output.replace(/<\/t[dh]>/gi, '\t');
    output = output.replace(/<[^>]+>/g, '');

    const decoder = document.createElement('textarea');
    decoder.innerHTML = output;
    return decoder.value;
}

ipcRenderer.on('word-questions-extracted', (event, data) => {
    if (data && data.success) {
        const text = data.html ? htmlToMarkedText(data.html) : (data.text || '');
        parseAndSaveQuestions(text, data.quizTitle);
    } else {
        alert((data && data.message) ? data.message : "Failed to read Word document. Ensure it is a valid .docx file.");
    }
});

ipcRenderer.on('excel-questions-imported', (event, data) => {
    if (data && data.success) {
        alert(data.message || 'Excel questions imported successfully.');
    } else {
        alert((data && data.message) ? data.message : 'Failed to read the Excel workbook.');
    }
});

// --- OMNI-FORMAT QUESTION PARSER (Word, Excel-paste, Smart Paste) ---
const IMPORT_IGNORE_LINE_REGEX = /^(?:[-=_~#]{3,}.*|thank\s*you[\s\.\…!]*$|[a-z]{2,4}\s*\d{3}\s*[\-–—:].*|negros\s+oriental\s+state\s+university.*|college\s+of\s+industrial\s+technology.*|bayawan.*|(?:midterm|final|prelim|periodic|long|short)\s*(?:term\s*)?exam.*|(?:first|second|third|fourth|1st|2nd|3rd|4th)\s*(?:semester|quarter).*|name\s*:.*|(?:major\s*&?\s*section|section|subject|date|course|year\s*(?:&|and)\s*section|instructor|teacher|score)\s*:.*|directions?\s*:.*|instructions?\s*:.*|read\s+(?:and|the|each)\b.*|choose\s+the\s+best\b.*|write\s+the\s+letter\b.*|encircle\b.*|good\s+luck[\s\.!]*$|god\s+bless[\s\.!]*$|prepared\s+by\s*:.*|checked\s+by\s*:.*|approved\s+by\s*:.*|noted\s+by\s*:.*|page\s*\d+.*)$/i;

const INLINE_OPTION_REGEX = /(^|[\s;|])(\*{0,3}\s*)(?:\(\s*([A-Da-d])\s*\)|\[\s*([A-Da-d])\s*\]|([A-Da-d])\s*\*{0,3}\s*[\.\)\:\-])\s*/g;

function sanitizeImportHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeImportText(rawText) {
    return String(rawText || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\v\f\u000B\u0085\u2028\u2029]/g, '\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[＊∗⁎]/g, '*')
        .replace(/\u00a0/g, ' ');
}

// Word tables and pasted columns separate choices with tabs or wide gaps instead of letters.
function splitSpatialOptionLine(line) {
    const raw = String(line || '');
    if (!raw.includes('\t') && !/\s{3,}/.test(raw)) return null;

    const compact = raw.replace(/\s+/g, ' ').trim();
    if (!compact) return null;
    // Leave prompts, matching pairs, headers, and already-lettered rows to the existing parsers.
    if (compact.includes('=')) return null;
    if (IMPORT_IGNORE_LINE_REGEX.test(compact)) return null;
    if (new RegExp(INLINE_OPTION_REGEX.source).test(compact)) return null;
    if (looksLikeQuestionLine(compact)) return null;
    if (/^\d{1,3}\s*[\.\)\:]\s*\S/.test(compact)) return null;
    if (/^(?:name|date|score|section|subject|course|instructor|teacher|year|semester|quarter|grade)\b/i.test(compact)) return null;

    const parts = raw.split(/\t+|\s{3,}/)
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    return parts.length >= 2 ? parts : null;
}

function isIgnorableImportLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return true;
    if (/^\*{1,3}$/.test(raw)) return false; // keep standalone markers so they can be merged below
    const text = raw.replace(/\*/g, '').trim();
    if (!text) return true;
    if (IMPORT_IGNORE_LINE_REGEX.test(text)) return true;
    if (/^(?:test|part|section|exam)\s*[ivxlcdm\d]+\b/i.test(text)) return true;
    if (/^[ivxlcdm]+\.\s*(?:multiple\s+choice|true\s*(?:or|\/)\s*false|false|identification|matching|enumeration|essay)/i.test(text)) return true;
    return false;
}

// If a prompt and its options are squished onto one line, split them apart.
function splitPromptAndOptions(line) {
    const raw = String(line || '').trim();
    if (!raw) return null;

    const scanner = new RegExp(INLINE_OPTION_REGEX.source, 'g');
    let match;
    while ((match = scanner.exec(raw)) !== null) {
        const markerStart = match.index + match[1].length;
        const label = (match[3] || match[4] || match[5] || '').toUpperCase();
        const before = raw.slice(0, markerStart).trim();

        if (before && label === 'A' && (/^\d{1,3}\s*[\.\)\:]/.test(before) || /[?:]$/.test(before))) {
            const optionsLine = raw.slice(markerStart);
            const parsed = parseOptionLine(optionsLine);
            if (parsed && parsed.options.length >= 2) {
                return { prompt: before, optionsLine: optionsLine };
            }
        }

        if (scanner.lastIndex === match.index) scanner.lastIndex++;
    }
    return null;
}

function splitImportLines(rawText) {
    const baseLines = [];
    normalizeImportText(rawText)
        .replace(/\n\s*ANSWER\s+KEY\b[\s\S]*$/i, '')
        .split('\n')
        .forEach(rawLine => {
            const spatialOptions = splitSpatialOptionLine(rawLine);
            const lineParts = spatialOptions || [rawLine.replace(/\s+/g, ' ').trim()];
            lineParts.forEach(line => {
                if (line !== '' && !isIgnorableImportLine(line)) baseLines.push(line);
            });
        });

    // Re-attach standalone '*' or option-label lines that Word tables split apart.
    const mergedLines = [];
    for (let k = 0; k < baseLines.length; k++) {
        const line = baseLines[k];
        if (/^\*{1,3}$/.test(line) && k + 1 < baseLines.length) {
            baseLines[k + 1] = line + baseLines[k + 1];
        } else if (/^(?:\*{1,3}\s*)?(?:\(\s*[A-Da-d]\s*\)|\[\s*[A-Da-d]\s*\]|[A-Da-d]\s*[\.\)\:\-])$/.test(line) && k + 1 < baseLines.length) {
            baseLines[k + 1] = line + ' ' + baseLines[k + 1];
        } else {
            mergedLines.push(line);
        }
    }

    const expanded = [];
    mergedLines.forEach(line => {
        const split = splitPromptAndOptions(line);
        if (split) {
            expanded.push(split.prompt);
            expanded.push(split.optionsLine);
        } else {
            expanded.push(line);
        }
    });
    return expanded;
}

// Parse one line that may hold one option, a 2x2 row (A/B), or a 1x4 inline row.
function parseOptionLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return null;

    const markers = [];
    INLINE_OPTION_REGEX.lastIndex = 0;

    let match;
    while ((match = INLINE_OPTION_REGEX.exec(raw)) !== null) {
        markers.push({
            label: (match[3] || match[4] || match[5] || '').toUpperCase(),
            markerStart: match.index + match[1].length,
            textStart: INLINE_OPTION_REGEX.lastIndex,
            prefix: match[2] || ''
        });
        if (markers.length > 8) break;
        if (INLINE_OPTION_REGEX.lastIndex === match.index) INLINE_OPTION_REGEX.lastIndex++;
    }

    if (markers.length === 0) return null;

    const leading = raw.slice(0, markers[0].markerStart).replace(/\*/g, '').trim();
    if (leading) return null;

    if (markers.length === 1) {
        const text = raw.slice(markers[0].textStart).trim();
        if (!text) return null;
        return {
            inline: false,
            options: [{
                label: markers[0].label,
                rawText: text,
                marked: /\*/.test(markers[0].prefix) || /\*/.test(text)
            }]
        };
    }

    let lastIndex = -1;
    for (const marker of markers) {
        const index = 'ABCD'.indexOf(marker.label);
        if (index < 0 || index <= lastIndex) return null;
        lastIndex = index;
    }

    const options = markers.map((marker, index) => {
        const end = index + 1 < markers.length ? markers[index + 1].markerStart : raw.length;
        const text = raw.slice(marker.textStart, end).trim();
        return {
            label: marker.label,
            rawText: text,
            marked: /\*/.test(marker.prefix) || /\*/.test(text)
        };
    });

    return { inline: true, options: options };
}

function gatherLabeledOptions(lines, startIndex) {
    const slots = { A: null, B: null, C: null, D: null };
    let i = startIndex;

    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }

        const parsed = parseOptionLine(line);
        if (!parsed) break;

        parsed.options.forEach(option => {
            if (slots[option.label] === null) slots[option.label] = option;
        });

        i++;
        if (slots.A && slots.B && slots.C && slots.D) break;
    }

    return {
        options: ['A', 'B', 'C', 'D'].map(label => slots[label]).filter(Boolean),
        slots: slots,
        endIndex: i
    };
}

function looksLikeQuestionLine(line) {
    const text = String(line || '').replace(/\*/g, '').trim();
    if (!text) return false;
    if (/^\d{1,3}\s*[\.\)\:]\s+\S/.test(text)) return true;
    if (/\?$/.test(text)) return true;
    return false;
}

function gatherUnlabeledOptions(lines, startIndex) {
    const options = [];
    let i = startIndex;

    while (i < lines.length && options.length < 4) {
        const line = lines[i];
        if (!line) { i++; continue; }
        if (isIgnorableImportLine(line)) break;
        if (parseOptionLine(line)) break;
        if (options.length > 0 && looksLikeQuestionLine(line)) break;
        if (/^\d{1,3}\s*[\.\)\:]\s+\S/.test(line.trim())) break;

        options.push({
            label: 'ABCD'[options.length],
            rawText: line,
            marked: /\*/.test(line)
        });
        i++;
    }

    return { options: options, endIndex: i };
}

function gatherMatchPairs(lines, startIndex) {
    const pairs = [];
    let i = startIndex;

    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }
        if (!line.includes('=')) break;
        if (parseOptionLine(line)) break;

        const parts = line.split('=');
        const left = parts[0].replace(/^\*?[a-zA-Z0-9][\.\)]\s*/i, '').trim();
        const right = parts.slice(1).join('=').trim();
        if (!left || !right) break;

        pairs.push({ p: sanitizeImportHtml(left), a: sanitizeImportHtml(right) });
        i++;
    }

    return { pairs: pairs, endIndex: i };
}

function getTrueFalseValue(line) {
    let text = String(line || '').replace(/\*/g, '').trim();
    text = text.replace(/^(?:\(\s*[A-Da-d]\s*\)|\[\s*[A-Da-d]\s*\]|[A-Da-d]\s*[\.\)\:\-])\s*/, '').trim();
    if (/^true$/i.test(text)) return 'True';
    if (/^false$/i.test(text)) return 'False';
    return null;
}

function lineHasCorrectMark(line) {
    const raw = String(line || '');
    if (!raw.includes('*')) return false;
    return /^\s*\*{1,3}\s*\S/.test(raw)
        || /\S\s*\*{1,3}\s*$/.test(raw)
        || /\*{1,3}\s*[A-Da-d]\s*[\.\)]/.test(raw)
        || /[\.\)\:]\s*\*{1,3}\s*\S/.test(raw);
}

function cleanImportOptionText(option) {
    let text = String(option && option.rawText ? option.rawText : '').replace(/\*/g, '').trim();
    text = text.replace(/^(?:\(\s*[A-Da-d]\s*\)|\[\s*[A-Da-d]\s*\]|[A-Da-d]\s*[\.\)\:\-])\s*/, '').trim();
    return sanitizeImportHtml(text);
}

function cleanImportQuestionText(line) {
    let text = String(line || '').replace(/\*/g, '').trim();
    text = text.replace(/^\d{1,3}\s*[\.\)\:]\s*/, '').trim();
    return sanitizeImportHtml(text);
}

function parseQuestionsFromText(rawText) {
    const lines = splitImportLines(rawText);
    const parsedQuestions = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (isIgnorableImportLine(line) || parseOptionLine(line)) {
            i++;
            continue;
        }

        const qText = cleanImportQuestionText(line);
        if (!qText) { i++; continue; }

        // 1. TRUE/FALSE
        const firstTf = getTrueFalseValue(lines[i + 1]);
        const secondTf = getTrueFalseValue(lines[i + 2]);
        if (firstTf && secondTf && firstTf !== secondTf) {
            const firstMarked = lineHasCorrectMark(lines[i + 1]);
            const secondMarked = lineHasCorrectMark(lines[i + 2]);
            let correct = 'A';
            if (firstMarked) correct = firstTf === 'True' ? 'A' : 'B';
            else if (secondMarked) correct = secondTf === 'True' ? 'A' : 'B';

            parsedQuestions.push({
                question_text: qText,
                option_a: 'True', option_b: 'False', option_c: '', option_d: '',
                correct_answer: correct, question_type: 'tf', extended_data: null
            });
            i += 3;
            continue;
        }

        // 2. MATCHING TYPE
        if (lines[i + 1] && lines[i + 1].includes('=') && !parseOptionLine(lines[i + 1])) {
            const matching = gatherMatchPairs(lines, i + 1);
            if (matching.pairs.length >= 2) {
                parsedQuestions.push({
                    question_text: qText || 'Match the following items:',
                    option_a: '', option_b: '', option_c: '', option_d: '',
                    correct_answer: '', question_type: 'match', extended_data: matching.pairs
                });
                i = matching.endIndex;
                continue;
            }
        }

        // 3. LABELED MULTIPLE CHOICE (vertical, 2x2 grid, or 1x4 inline)
        const labeled = gatherLabeledOptions(lines, i + 1);
        if (labeled.slots.A && labeled.slots.B) {
            let correct = 'A';
            for (const label of ['A', 'B', 'C', 'D']) {
                if (labeled.slots[label] && labeled.slots[label].marked) {
                    correct = label;
                    break;
                }
            }

            parsedQuestions.push({
                question_text: qText,
                option_a: cleanImportOptionText(labeled.slots.A),
                option_b: cleanImportOptionText(labeled.slots.B),
                option_c: labeled.slots.C ? cleanImportOptionText(labeled.slots.C) : '',
                option_d: labeled.slots.D ? cleanImportOptionText(labeled.slots.D) : '',
                correct_answer: correct,
                question_type: 'mcq',
                extended_data: null
            });
            i = labeled.endIndex;
            continue;
        }

        // 4. NUMBERLESS / LETTERLESS CHOICES (auto-assigned A-D)
        const unlabeled = gatherUnlabeledOptions(lines, i + 1);
        if (unlabeled.options.length === 4) {
            const markedIndex = unlabeled.options.findIndex(option => option.marked);
            parsedQuestions.push({
                question_text: qText,
                option_a: cleanImportOptionText(unlabeled.options[0]),
                option_b: cleanImportOptionText(unlabeled.options[1]),
                option_c: cleanImportOptionText(unlabeled.options[2]),
                option_d: cleanImportOptionText(unlabeled.options[3]),
                correct_answer: markedIndex >= 0 ? 'ABCD'[markedIndex] : 'A',
                question_type: 'mcq',
                extended_data: null
            });
            i = unlabeled.endIndex;
            continue;
        }

        // 5. IDENTIFICATION
        const answerLine = lines[i + 1];
        if (answerLine && !parseOptionLine(answerLine) &&
            (lineHasCorrectMark(answerLine) || /^answer\s*[:=-]\s*/i.test(answerLine))) {
            const answerText = String(answerLine)
                .replace(/^\*{1,3}\s*/, '')
                .replace(/\s*\*{1,3}$/, '')
                .replace(/^answer\s*[:=-]\s*/i, '')
                .trim();

            if (answerText) {
                parsedQuestions.push({
                    question_text: qText,
                    option_a: '', option_b: '', option_c: '', option_d: '',
                    correct_answer: sanitizeImportHtml(answerText),
                    question_type: 'ident', extended_data: null
                });
                i += 2;
                continue;
            }
        }

        i++;
    }

    return parsedQuestions;
}

function parseAndSaveQuestions(rawText, selectedQuiz) {
    const parsedQuestions = parseQuestionsFromText(rawText);

    if (parsedQuestions.length === 0) {
        alert("Could not read any valid questions from the provided text. Mark correct answers with an * asterisk, red text, or a highlight.");
        return;
    }

    ipcRenderer.send('add-questions', { quizTitle: selectedQuiz, questions: parsedQuestions });
}

ipcRenderer.on('questions-saved-success', (event, count) => { alert(`Success! ${count} questions have been added to the database.`); fetchQuestions(); });

function filterQuizzes() {
    const searchEl = document.getElementById('quiz-search-input');
    const subjectEl = document.getElementById('quiz-filter-select');
    const searchInput = searchEl ? searchEl.value.toLowerCase() : '';
    const subjectFilter = subjectEl ? subjectEl.value.toLowerCase() : 'all';
    const rows = document.querySelectorAll('#quiz-table-body tr');
    const allowedSubjects = getActiveSubjectNames();

    rows.forEach(row => {
        if (row.cells.length < 2) return; 
        const subjectName = row.getAttribute('data-subject') || row.cells[1].innerText;
        const title = row.cells[0].innerText.toLowerCase();
        const subject = subjectName.toLowerCase();
        const matchesInstructor = !allowedSubjects || allowedSubjects.has(subjectName);
        const matchesSearch = title.includes(searchInput) || subject.includes(searchInput);
        const matchesSubject = subjectFilter === 'all' || subject === subjectFilter;
        row.style.display = (matchesInstructor && matchesSearch && matchesSubject) ? '' : 'none';
    });
}

function fetchQuestions() {
    const selectedQuiz = document.getElementById('question-quiz-select').value;
    if (selectedQuiz) {
        ipcRenderer.send('get-questions-by-quiz', selectedQuiz);
        ['btn-smart-paste', 'btn-add-question', 'btn-word-import', 'btn-excel-import', 'btn-print-exam'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) { btn.disabled = false; btn.className = 'btn btn-secondary'; }
        });
        const clearBtn = document.getElementById('btn-clear-questions');
        if (clearBtn) { clearBtn.disabled = false; clearBtn.className = 'btn btn-danger'; }

        const recoverBtn = document.getElementById('btn-recover-questions');
        if (recoverBtn) {
            const hasBackups = backupDeletedQuestions[selectedQuiz] && backupDeletedQuestions[selectedQuiz].length > 0;
            recoverBtn.disabled = !hasBackups;
            recoverBtn.className = 'btn btn-secondary';
        }
    }
}

let currentLoadedQuestions = []; 

ipcRenderer.on('load-questions', (event, questions) => {
    currentLoadedQuestions = questions; 
    const container = document.getElementById('questions-list-container');
    const countBadge = document.getElementById('question-count-badge');
    container.innerHTML = ''; 
    countBadge.innerText = `${questions.length} Questions`;

    if (questions.length === 0) {
        container.innerHTML = `<div class="p-8 text-center text-slate-500 dark:text-slate-500 font-medium">No questions found for this quiz. Use Smart Paste or Add Question to begin!</div>`;
        return;
    }

    const escapePreview = (str) => String(str || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    questions.forEach((q, index) => {
        let typeBadge = "";
        let previewHtml = "";

        if (q.question_type === 'tf') {
            typeBadge = `<span class="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded text-[10px] font-black uppercase border border-transparent dark:border-blue-800/50">True/False</span>`;
            previewHtml = `<p class="text-xs mt-1"><span class="font-bold text-slate-500 dark:text-slate-400">Answer:</span> <span class="text-green-600 dark:text-green-500 font-bold">${q.correct_answer === 'A' ? 'True' : 'False'}</span></p>`;
        } else if (q.question_type === 'ident') {
            typeBadge = `<span class="bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 px-2 py-0.5 rounded text-[10px] font-black uppercase border border-transparent dark:border-purple-800/50">Identification</span>`;
            previewHtml = `<p class="text-xs mt-1"><span class="font-bold text-slate-500 dark:text-slate-400">Answer:</span> <span class="text-green-600 dark:text-green-500 font-bold">${escapePreview(q.correct_answer)}</span></p>`;
        } else if (q.question_type === 'match') {
            typeBadge = `<span class="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-2 py-0.5 rounded text-[10px] font-black uppercase border border-transparent dark:border-orange-800/50">Matching</span>`;
            previewHtml = `<p class="text-xs mt-1 italic text-slate-400 dark:text-slate-500">Contains paired definitions.</p>`;
        } else {
            typeBadge = `<span class="bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded text-[10px] font-black uppercase">Multiple Choice</span>`;
            previewHtml = `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                    <span class="${q.correct_answer === 'A' ? 'text-green-600 dark:text-green-400 font-bold' : ''}">A) ${escapePreview(q.option_a) || '<em class="text-red-500 font-bold">Empty (Edit or Re-import)</em>'}</span>
                    <span class="${q.correct_answer === 'B' ? 'text-green-600 dark:text-green-400 font-bold' : ''}">B) ${escapePreview(q.option_b) || '<em class="text-red-500 font-bold">Empty (Edit or Re-import)</em>'}</span>
                    <span class="${q.correct_answer === 'C' ? 'text-green-600 dark:text-green-400 font-bold' : ''}">C) ${escapePreview(q.option_c) || '<em class="text-red-500 font-bold">Empty (Edit or Re-import)</em>'}</span>
                    <span class="${q.correct_answer === 'D' ? 'text-green-600 dark:text-green-400 font-bold' : ''}">D) ${escapePreview(q.option_d) || '<em class="text-red-500 font-bold">Empty (Edit or Re-import)</em>'}</span>
                </div>
            `;
        }

        container.insertAdjacentHTML('beforeend', `
            <div class="p-5 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-start justify-between gap-4">
                <div class="space-y-1 flex-1">
                    <div class="flex items-center gap-2 mb-1">${typeBadge}</div>
                    <p class="font-bold text-slate-800 dark:text-slate-200"><span class="text-blue-600 dark:text-blue-400 mr-1">Q${index + 1}.</span> ${escapePreview(q.question_text)}</p>
                    ${previewHtml}
                </div>
                <div class="flex flex-col gap-2">
                    <button type="button" onclick="openQuestionBuilder(${q.id})" class="text-slate-400 dark:text-slate-500 hover:text-blue-500 dark:hover:text-blue-400 p-2 transition-colors" title="Edit Question"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" onclick="deleteRealQuestion(${q.id}, '${q.quiz_title}')" class="text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 p-2 transition-colors" title="Delete Question"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `);
    });
});

function toggleBuilderFields() {
    const type = document.getElementById('builder-q-type').value;
    document.querySelectorAll('.builder-section').forEach(el => el.classList.add('hidden'));
    
    const fieldSection = document.getElementById(`fields-${type}`);
    if (fieldSection) fieldSection.classList.remove('hidden');

    const label = document.getElementById('label-q-text');
    if (type === 'match') label.innerText = "Matching Instructions (e.g. Match the terms)";
    else label.innerText = "Question Text";
}

function openQuestionBuilder(id = null) {
    const desanitize = (str) => {
        if (!str) return "";
        return str.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    };

    document.getElementById('builder-q-id').value = "";
    document.getElementById('builder-q-type').value = "mcq";
    document.getElementById('builder-q-text').value = "";
    document.getElementById('builder-mcq-a').value = "";
    document.getElementById('builder-mcq-b').value = "";
    document.getElementById('builder-mcq-c').value = "";
    document.getElementById('builder-mcq-d').value = "";
    document.getElementById('builder-ident-correct').value = "";
    
    for(let i=1; i<=4; i++) {
        document.getElementById(`match-p${i}`).value = ""; document.getElementById(`match-a${i}`).value = "";
    }

    if (id) {
        const q = currentLoadedQuestions.find(item => item.id === id);
        if (!q) return;

        document.getElementById('builder-title').innerHTML = `<i class="fa-solid fa-pen text-blue-500 mr-2"></i> Edit Question`;
        document.getElementById('builder-q-id').value = q.id;
        
        let safeType = q.question_type || 'mcq';
        if (safeType === 'code') safeType = 'mcq'; 
        document.getElementById('builder-q-type').value = safeType;
        
        document.getElementById('builder-q-text').value = desanitize(q.question_text);

        if (safeType === 'mcq') {
            document.getElementById('builder-mcq-a').value = desanitize(q.option_a);
            document.getElementById('builder-mcq-b').value = desanitize(q.option_b);
            document.getElementById('builder-mcq-c').value = desanitize(q.option_c);
            document.getElementById('builder-mcq-d').value = desanitize(q.option_d);
            document.getElementById('builder-mcq-correct').value = q.correct_answer || 'A';
        } else if (safeType === 'tf') {
            document.getElementById('builder-tf-correct').value = q.correct_answer === 'A' ? 'True' : 'False';
        } else if (safeType === 'ident') {
            document.getElementById('builder-ident-correct').value = desanitize(q.correct_answer);
        } else if (safeType === 'match') {
            if (q.extended_data) {
                try {
                    const data = JSON.parse(q.extended_data);
                    data.forEach((pair, idx) => {
                        if(idx < 4) {
                            document.getElementById(`match-p${idx+1}`).value = desanitize(pair.p);
                            document.getElementById(`match-a${idx+1}`).value = desanitize(pair.a);
                        }
                    });
                } catch(e) {}
            }
        }
    } else {
        document.getElementById('builder-title').innerHTML = `<i class="fa-solid fa-plus text-green-500 mr-2"></i> Add New Question`;
    }

    toggleBuilderFields();
    openModal('modal-question-builder');
}

function saveQuestionBuilder() {
    const id = document.getElementById('builder-q-id').value;
    const quiz_title = document.getElementById('question-quiz-select').value;
    const type = document.getElementById('builder-q-type').value;
    
    const sanitize = (str) => {
        if (!str) return "";
        return str.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };

    const question_text = sanitize(document.getElementById('builder-q-text').value.trim());
    if (!question_text) { alert("Please enter the question text/instructions."); return; }

    let option_a = "", option_b = "", option_c = "", option_d = "", correct_answer = "", extended_data = null;

    if (type === 'mcq') {
        option_a = sanitize(document.getElementById('builder-mcq-a').value.trim());
        option_b = sanitize(document.getElementById('builder-mcq-b').value.trim());
        option_c = sanitize(document.getElementById('builder-mcq-c').value.trim());
        option_d = sanitize(document.getElementById('builder-mcq-d').value.trim());
        correct_answer = document.getElementById('builder-mcq-correct').value;
        if(!option_a || !option_b) { alert("MCQ requires at least Option A and B."); return; }
    } 
    else if (type === 'tf') {
        option_a = "True"; option_b = "False";
        correct_answer = document.getElementById('builder-tf-correct').value === 'True' ? 'A' : 'B';
    }
    else if (type === 'ident') {
        correct_answer = sanitize(document.getElementById('builder-ident-correct').value.trim());
        if(!correct_answer) { alert("Please enter the exact answer."); return; }
    }
    else if (type === 'match') {
        let pairs = [];
        for(let i=1; i<=4; i++) {
            let p = sanitize(document.getElementById(`match-p${i}`).value.trim());
            let a = sanitize(document.getElementById(`match-a${i}`).value.trim());
            if (p && a) pairs.push({p: p, a: a});
        }
        if(pairs.length < 2) { alert("Matching requires at least 2 pairs."); return; }
        extended_data = pairs;
    }

    if (id) {
        ipcRenderer.send('update-question', { id: id, quiz_title: quiz_title, question_text: question_text, option_a: option_a, option_b: option_b, option_c: option_c, option_d: option_d, correct_answer: correct_answer, question_type: type, extended_data: extended_data ? JSON.stringify(extended_data) : null });
    } else {
        ipcRenderer.send('add-questions', {
            quizTitle: quiz_title,
            questions: [{
                question_text: question_text, option_a: option_a, option_b: option_b, option_c: option_c, option_d: option_d, correct_answer: correct_answer, question_type: type, extended_data: extended_data ? JSON.stringify(extended_data) : null
            }]
        });
    }

    closeModal('modal-question-builder');
}

function deleteRealQuestion(id, quizTitle) { customConfirm("Are you sure you want to delete this question?", () => ipcRenderer.send('delete-question', { id, quizTitle })); }

function deleteAllQuestions() { 
    const selectedQuiz = document.getElementById('question-quiz-select').value;
    if (!selectedQuiz) return;
    if (currentLoadedQuestions.length === 0) { alert("There are no questions to delete in this quiz."); return; }
    
    customConfirm(`WARNING: Are you sure you want to completely DELETE ALL ${currentLoadedQuestions.length} questions for "${selectedQuiz}"?`, () => { 
        backupDeletedQuestions[selectedQuiz] = JSON.parse(JSON.stringify(currentLoadedQuestions));
        ipcRenderer.send('delete-all-questions', selectedQuiz); 
        
        const recoverBtn = document.getElementById('btn-recover-questions');
        if (recoverBtn) {
            recoverBtn.disabled = false;
            recoverBtn.className = 'btn btn-secondary';
        }
    }); 
}

function recoverQuestions() {
    const selectedQuiz = document.getElementById('question-quiz-select').value;
    if (!selectedQuiz) return;
    
    const backup = backupDeletedQuestions[selectedQuiz];
    if (!backup || backup.length === 0) {
        alert("There are no recently deleted questions to recover for this quiz.");
        return;
    }

    customConfirm(`Are you sure you want to RECOVER ${backup.length} questions to "${selectedQuiz}"?`, () => {
        const questionsToRecover = backup.map(q => {
            let parsedExt = null;
            if (q.extended_data) {
                try { parsedExt = typeof q.extended_data === 'string' ? JSON.parse(q.extended_data) : q.extended_data; } 
                catch(e) { parsedExt = q.extended_data; }
            }
            return {
                question_text: q.question_text,
                option_a: q.option_a,
                option_b: q.option_b,
                option_c: q.option_c,
                option_d: q.option_d,
                correct_answer: q.correct_answer,
                question_type: q.question_type,
                extended_data: parsedExt
            };
        });

        ipcRenderer.send('add-questions', { quizTitle: selectedQuiz, questions: questionsToRecover });
        backupDeletedQuestions[selectedQuiz] = [];
        
        const recoverBtn = document.getElementById('btn-recover-questions');
        if (recoverBtn) {
            recoverBtn.disabled = true;
            recoverBtn.className = 'btn btn-secondary';
        }
    });
}

function filterResults() {
    const searchEl = document.getElementById('result-search-input');
    const quizEl = document.getElementById('result-filter-select');
    const sectionEl = document.getElementById('result-section-filter');
    const searchInput = searchEl ? searchEl.value.toLowerCase() : '';
    const quizFilter = quizEl ? quizEl.value : 'all';
    const sectionFilter = sectionEl ? sectionEl.value : 'all';
    const rows = document.querySelectorAll('#results-table-body tr');
    const allowedQuizTitles = getActiveQuizTitles();

    rows.forEach(row => {
        if (row.cells.length < 4) return; 
        const studentName = row.cells[0].innerText.toLowerCase();
        const studentId = row.cells[1].innerText.toLowerCase();
        const section = row.cells[2].getAttribute('data-section') || row.cells[2].innerText; 
        const quizTitle = row.getAttribute('data-quiz') || row.cells[3].innerText; 
        
        const matchesInstructor = !allowedQuizTitles || allowedQuizTitles.has(quizTitle);
        const matchesSearch = studentName.includes(searchInput) || studentId.includes(searchInput);
        const matchesQuiz = quizFilter === 'all' || quizTitle === quizFilter;
        const matchesSection = sectionFilter === 'all' || section === sectionFilter; 
        
        row.style.display = (matchesInstructor && matchesSearch && matchesQuiz && matchesSection) ? '' : 'none';
    });
}

// FIXED: Export Results to CSV (Respects active Quiz, Section, and Search filters)
function exportResultsToCSV() {
    const quizEl = document.getElementById('result-filter-select');
    const sectionEl = document.getElementById('result-section-filter');
    const searchEl = document.getElementById('result-search-input');

    const filters = {
        quizTitle: quizEl ? quizEl.value : 'all',
        section: sectionEl ? sectionEl.value : 'all',
        search: searchEl ? searchEl.value.trim() : '',
        instructor: getActiveInstructor()
    };
    ipcRenderer.send('export-csv', filters);
}

// Batch 3: PDF export of exam results using the current filters.
function exportResultsPDF() {
    const quizEl = document.getElementById('result-filter-select');
    const sectionEl = document.getElementById('result-section-filter');
    const searchEl = document.getElementById('result-search-input');

    ipcRenderer.send('export-results-pdf', {
        quizTitle: quizEl ? quizEl.value : 'all',
        section: sectionEl ? sectionEl.value : 'all',
        search: searchEl ? searchEl.value.trim() : '',
        instructor: getActiveInstructor()
    });
}

// --- BATCH 3: AUTOMATED ATTENDANCE ---

ipcRenderer.on('load-attendance', (event, rows) => {
    allAttendance = rows || [];
    renderAttendanceTable();
});

function attendanceRowSubject(row) {
    if (row && row.subject) return String(row.subject).trim();
    const quiz = (allQuizzes || []).find(q => q.title === row.quiz_title);
    return quiz ? String(quiz.subject || '').trim() : '';
}

// Batch 1: attendance is scoped by the subject that owns the quiz, so a same-titled
// quiz under another instructor can never leak into this instructor's view.
// The server resolves instructor_name per row, so this stays correct even before
// the subjects/quizzes caches finish loading.
function getScopedAttendanceRows() {
    if (isMasterInstructorView()) return allAttendance || [];
    const activeInstructor = getActiveInstructor();

    return (allAttendance || []).filter(row => {
        if (row && row.instructor_name) {
            return instructorNamesMatch(row.instructor_name, activeInstructor);
        }
        const subject = attendanceRowSubject(row);
        const allowedSubjects = getActiveSubjectNames();
        return !!(subject && allowedSubjects && allowedSubjects.has(subject));
    });
}

function attendanceFilterKey(rowOrSubject, maybeQuizTitle) {
    const isRow = rowOrSubject && typeof rowOrSubject === 'object';
    const subject = isRow ? attendanceRowSubject(rowOrSubject) : String(rowOrSubject || '').trim();
    const quizTitle = isRow ? String(rowOrSubject.quiz_title || '').trim() : String(maybeQuizTitle || '').trim();
    return `${subject}|||${quizTitle}`;
}

function parseAttendanceFilterKey(value) {
    const raw = String(value || 'all');
    if (raw === 'all') return { subject: 'all', quizTitle: 'all' };
    const separator = raw.indexOf('|||');
    if (separator < 0) return { subject: 'all', quizTitle: raw };
    return {
        subject: raw.slice(0, separator),
        quizTitle: raw.slice(separator + 3)
    };
}

function renderAttendanceTable() {
    const tableBody = document.getElementById('attendance-table-body');
    if (!tableBody) return;

    const rows = getScopedAttendanceRows();

    const quizFilterSelect = document.getElementById('attendance-quiz-filter');
    if (quizFilterSelect) {
        const currentFilter = quizFilterSelect.value || 'all';
        const filterOptions = new Map();
        rows.forEach(row => {
            if (!row.quiz_title) return;
            const key = attendanceFilterKey(row);
            if (!filterOptions.has(key)) {
                filterOptions.set(key, {
                    subject: attendanceRowSubject(row),
                    title: String(row.quiz_title)
                });
            }
        });

        quizFilterSelect.innerHTML = '<option value="all">All Quizzes</option>';
        [...filterOptions.entries()]
            .sort((a, b) => {
                const left = `${a[1].subject} ${a[1].title}`.toLowerCase();
                const right = `${b[1].subject} ${b[1].title}`.toLowerCase();
                return left.localeCompare(right);
            })
            .forEach(([key, option]) => {
                const label = option.subject ? `${option.subject} — ${option.title}` : option.title;
                quizFilterSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`);
            });
        quizFilterSelect.value = filterOptions.has(currentFilter) ? currentFilter : 'all';
    }

    const countEl = document.getElementById('attendance-count');
    if (countEl) countEl.innerText = `${rows.length} record${rows.length === 1 ? '' : 's'}`;

    tableBody.innerHTML = '';

    if (rows.length === 0) {
        const emptyMsg = isMasterInstructorView()
            ? 'No attendance recorded yet. Records appear automatically when a student submits a quiz.'
            : 'No attendance recorded for this instructor\'s quizzes yet.';
        tableBody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400 text-sm">${emptyMsg}</td></tr>`;
        return;
    }

    tableBody.innerHTML = rows.map(row => {
        const status = ['Present', 'Absent', 'Late'].includes(row.status) ? row.status : 'Present';
        const statusTone = status === 'Present'
            ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800/50 dark:bg-green-900/20 dark:text-green-400'
            : status === 'Late'
                ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-400'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-400';

        const sectionBadge = row.course_section && row.course_section !== 'Unknown'
            ? `<span class="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2 py-0.5 rounded text-[11px] font-medium border border-slate-200 dark:border-slate-700">${escapeHtml(row.course_section)}</span>`
            : `<span class="text-slate-400 dark:text-slate-600 italic text-xs">Unknown</span>`;

        return `
            <tr data-quiz="${escapeHtml(row.quiz_title)}" data-subject="${escapeHtml(attendanceRowSubject(row))}" class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <td class="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(row.student_name)}</td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400">${escapeHtml(row.student_id)}</td>
                <td class="px-4 py-2.5">${sectionBadge}</td>
                <td class="px-4 py-2.5 text-slate-600 dark:text-slate-300">${escapeHtml(row.quiz_title)}</td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">${escapeHtml(row.date_recorded)}</td>
                <td class="px-4 py-2.5 text-center whitespace-nowrap" data-warnings="${Number(row.incident_count || 0)}">${renderIncidentBadge(row.incident_count)}</td>
                <td class="px-4 py-2.5"><select class="attendance-status-select ${statusTone} rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide outline-none cursor-pointer" data-student-id="${escapeHtml(row.student_id)}" data-quiz="${escapeHtml(row.quiz_title)}" data-subject="${escapeHtml(attendanceRowSubject(row))}" data-date="${escapeHtml(row.date_recorded)}" aria-label="Attendance status for ${escapeHtml(row.student_name)}">${['Present', 'Absent', 'Late'].map(option => `<option value="${option}" ${option === status ? 'selected' : ''}>${option}</option>`).join('')}</select></td>
            </tr>`;
    }).join('');

    tableBody.querySelectorAll('.attendance-status-select').forEach(select => {
        select.addEventListener('change', () => updateAttendanceStatus(select));
    });

    filterAttendance();
}

function updateAttendanceStatus(selectEl) {
    if (!selectEl) return;
    const status = selectEl.value;
    if (!['Present', 'Absent', 'Late'].includes(status)) return;

    selectEl.disabled = true;
    ipcRenderer.send('update-attendance-status', {
        studentId: selectEl.getAttribute('data-student-id'),
        quizTitle: selectEl.getAttribute('data-quiz'),
        subject: selectEl.getAttribute('data-subject') || '',
        dateRecorded: selectEl.getAttribute('data-date'),
        status: status
    });
}

ipcRenderer.on('attendance-status-response', (event, response) => {
    if (response && response.success) return;
    alert((response && response.message) || 'Could not update attendance status.');
    ipcRenderer.send('get-attendance');
});

function filterAttendance() {
    const searchEl = document.getElementById('attendance-search-input');
    const quizEl = document.getElementById('attendance-quiz-filter');
    const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const filterValue = quizEl ? quizEl.value : 'all';

    document.querySelectorAll('#attendance-table-body tr').forEach(row => {
        if (row.cells.length < 4) return;
        const studentName = row.cells[0].innerText.toLowerCase();
        const studentId = row.cells[1].innerText.toLowerCase();
        const rowKey = attendanceFilterKey(row.getAttribute('data-subject') || '', row.getAttribute('data-quiz') || '');
        const matchesSearch = !search || studentName.includes(search) || studentId.includes(search);
        const matchesQuiz = filterValue === 'all' || rowKey === filterValue;
        row.style.display = (matchesSearch && matchesQuiz) ? '' : 'none';
    });
}

function exportAttendancePDF() {
    const quizEl = document.getElementById('attendance-quiz-filter');
    const searchEl = document.getElementById('attendance-search-input');
    const selected = parseAttendanceFilterKey(quizEl ? quizEl.value : 'all');

    ipcRenderer.send('export-attendance-pdf', {
        quizTitle: selected.quizTitle,
        subject: selected.subject,
        search: searchEl ? searchEl.value.trim() : '',
        instructor: getActiveInstructor()
    });
}

ipcRenderer.on('load-results', (event, results) => {
    allResults = results || [];
    renderResultsTable();
});

// v2.1.4: Incident Logging badge. Every anti-cheat warning increments this tally
// on the server; the exam is never auto-submitted for it.
function renderIncidentBadge(incidentCount) {
    const count = Number(incidentCount || 0);
    if (!count) {
        return '<span class="text-slate-400 dark:text-slate-600 text-[11px]">—</span>';
    }
    const label = `${count} Warning${count === 1 ? '' : 's'}`;
    return `<span class="inline-flex items-center gap-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border border-red-200 dark:border-red-800/50" title="Recorded anti-cheat incidents"><i class="fa-solid fa-triangle-exclamation"></i>${label}</span>`;
}

function renderResultsTable() {
    currentLoadedResults = allResults;
    // Instructor-scoped dataset: resolve each result's quiz -> subject -> instructor.
    const results = allResults.filter(resultBelongsToActiveInstructor);
    const tableBody = document.getElementById('results-table-body');
    const sectionFilterSelect = document.getElementById('result-section-filter'); 
    
    if (sectionFilterSelect) {
        const currentSectionFilter = sectionFilterSelect.value;
        sectionFilterSelect.innerHTML = '<option value="all">All Sections</option>';
        const uniqueSections = [...new Set(results.map(r => r.course_section).filter(sec => sec && sec !== 'Unknown'))];
        uniqueSections.sort().forEach(sec => {
            sectionFilterSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`);
        });
        if (uniqueSections.includes(currentSectionFilter)) sectionFilterSelect.value = currentSectionFilter;
    }

    if (!tableBody) return;
    tableBody.innerHTML = ''; 

    if (results.length === 0) {
        const emptyMsg = isMasterInstructorView()
            ? 'No quiz results recorded yet.'
            : 'No results recorded for this instructor\'s quizzes yet.';
        tableBody.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-slate-500 dark:text-slate-400 text-sm">${emptyMsg}</td></tr>`;
        filterResults();
        return;
    }

    results.forEach(result => {
        const statusBadge = result.status === 'Passed' ? `<span class="bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border border-green-200 dark:border-green-800/50">Passed</span>` : `<span class="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase border border-red-200 dark:border-red-800/50">Failed</span>`;
        const sectionBadge = result.course_section && result.course_section !== 'Unknown' 
            ? `<span class="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2 py-0.5 rounded text-[11px] font-medium border border-slate-200 dark:border-slate-700">${escapeHtml(result.course_section)}</span>` 
            : `<span class="text-slate-400 dark:text-slate-600 italic text-xs">Unknown</span>`;
        const warningBadge = renderIncidentBadge(result.incident_count);
        
        tableBody.insertAdjacentHTML('beforeend', `
            <tr data-quiz="${escapeHtml(result.quiz_title)}" class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <td class="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(result.student_name)}</td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400">${escapeHtml(result.student_id)}</td>
                <td class="px-4 py-2.5" data-section="${escapeHtml(result.course_section || '')}">${sectionBadge}</td>
                <td class="px-4 py-2.5 text-slate-600 dark:text-slate-300">${escapeHtml(result.quiz_title)}</td>
                <td class="px-4 py-2.5 text-center font-semibold text-slate-800 dark:text-slate-200">${result.score} / ${result.total_items}</td>
                <td class="px-4 py-2.5">${statusBadge}</td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">${escapeHtml(result.date_completed)}</td>
                <td class="px-4 py-2.5 text-center whitespace-nowrap" data-warnings="${Number(result.incident_count || 0)}">${warningBadge}</td>
                <td class="px-4 py-2.5 text-center space-x-1.5 whitespace-nowrap">
                    <button type="button" onclick="viewItemAnalysis(${result.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:border-blue-700 dark:hover:text-blue-300 transition-colors" title="View Item Analysis"><i class="fa-solid fa-eye text-[10px]"></i></button>
                    <button type="button" onclick="openEditScore(${result.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700 dark:hover:bg-amber-900/40 dark:hover:border-amber-700 dark:hover:text-amber-300 transition-colors" title="Edit Score / Give Partial Credit"><i class="fa-solid fa-pen-to-square text-[10px]"></i></button>
                    <button type="button" onclick="deleteResult(${result.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-50 hover:border-red-300 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:border-red-700 dark:hover:text-red-300 transition-colors" title="Delete Record"><i class="fa-solid fa-trash text-[10px]"></i></button>
                </td>
            </tr>
        `);
    });

    filterResults();
}

function deleteResult(id) { customConfirm("Are you sure you want to delete this quiz record? This action cannot be undone.", () => { ipcRenderer.send('delete-result', id); setTimeout(fetchDashboardStats, 500); }); }

function openEditScore(resultId) {
    const result = currentLoadedResults.find(r => String(r.id) === String(resultId));
    if (!result) {
        alert('Could not find the selected result record.');
        return;
    }

    document.getElementById('edit-score-result-id').value = result.id;
    document.getElementById('edit-score-student').innerText = result.student_name || '';
    document.getElementById('edit-score-quiz').innerText = result.quiz_title || '';
    document.getElementById('edit-score-total').innerText = result.total_items;

    const scoreInput = document.getElementById('edit-score-input');
    if (scoreInput) {
        scoreInput.max = result.total_items;
        scoreInput.value = result.score;
    }

    openModal('modal-edit-score');
    if (scoreInput) setTimeout(() => { scoreInput.focus(); scoreInput.select(); }, 50);
}

function saveEditedScore() {
    const id = document.getElementById('edit-score-result-id').value;
    const score = Number(document.getElementById('edit-score-input').value);

    if (!id) { alert('Could not identify the result record.'); return; }
    if (!Number.isFinite(score) || score < 0) { alert('Enter a valid score (0 or higher).'); return; }

    ipcRenderer.send('update-result-score', { id: Number(id), score: score });
}

ipcRenderer.on('result-score-updated', (event, data) => {
    if (!data || !data.success) {
        alert((data && data.message) ? data.message : 'Could not update the score.');
        return;
    }

    closeModal('modal-edit-score');

    const analysisScore = document.getElementById('analysis-score');
    if (analysisScore && activeAnalysisResultId !== null && String(activeAnalysisResultId) === String(data.id)) {
        analysisScore.innerText = `${data.score} / ${data.total_items}`;
    }

    setTimeout(fetchDashboardStats, 300);
});

function printExam() {
    const selectedQuiz = document.getElementById('question-quiz-select').value;
    if (!selectedQuiz || currentLoadedQuestions.length === 0) { alert("Please select a quiz and ensure it has questions before printing."); return; }

    let printContent = `
        <html><head><title>${selectedQuiz} - Master Copy</title>
        <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #000; }
            h1 { text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; text-transform: uppercase; }
            .header-info { display: flex; justify-content: space-between; margin-bottom: 30px; font-weight: bold; }
            .question-block { margin-bottom: 25px; page-break-inside: avoid; }
            .q-text { font-weight: bold; margin-bottom: 8px; font-size: 16px; }
            .options { margin-left: 20px; font-size: 15px; }
            .option { margin-bottom: 6px; }
            .match-container { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
            .match-item { border-bottom: 1px solid #ccc; padding-bottom: 4px; }
        </style>
        </head><body>
        <h1>${selectedQuiz}</h1>
        <div class="header-info">
            <span>Name: _______________________________________</span>
            <span>Date: ___________________</span>
            <span>Score: _______ / ${currentLoadedQuestions.length}</span>
        </div>
    `;

    currentLoadedQuestions.forEach((q, index) => {
        printContent += `<div class="question-block"><div class="q-text">${index + 1}. ${q.question_text}</div><div class="options">`;
        if (q.question_type === 'mcq') { printContent += `<div class="option">A) ${q.option_a}</div><div class="option">B) ${q.option_b}</div><div class="option">C) ${q.option_c}</div><div class="option">D) ${q.option_d}</div>`; } 
        else if (q.question_type === 'tf') { printContent += `<div class="option">True</div><div class="option">False</div>`; } 
        else if (q.question_type === 'ident') { printContent += `<br>__________________________________________________________________<br>`; } 
        else if (q.question_type === 'match') {
            printContent += `<p><em>(Match the correct pairs by drawing a line or writing the corresponding letter)</em></p><div class="match-container">`;
            if (q.extended_data) {
                try {
                    let pairs = JSON.parse(q.extended_data);
                    if (typeof pairs === 'string') pairs = JSON.parse(pairs);
                    let rightSide = pairs.map(p => p.a).sort(() => Math.random() - 0.5);
                    pairs.forEach((p, i) => { printContent += `<div class="match-item">____ ${p.p}</div><div class="match-item">${String.fromCharCode(65+i)}.) ${rightSide[i]}</div>`; });
                } catch(e){}
            }
            printContent += `</div>`;
        }
        printContent += `</div></div>`;
    });

    printContent += `</body></html>`;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); }, 500);
}

ipcRenderer.on('file-status', (event, response) => alert(response.message));
function fetchDashboardStats() { ipcRenderer.send('get-dashboard-stats', getActiveInstructor()); }

ipcRenderer.on('load-dashboard-stats', (event, stats) => {
    const elStudents = document.getElementById('stat-students');
    const elQuizzes = document.getElementById('stat-quizzes');
    const elQuestions = document.getElementById('stat-questions');
    const elResults = document.getElementById('stat-results');

    if(elStudents) elStudents.innerText = stats.students || 0;
    if(elQuizzes) elQuizzes.innerText = stats.quizzes || 0;
    if(elQuestions) elQuestions.innerText = stats.questions || 0;
    if(elResults) elResults.innerText = stats.results || 0;

    const recentQuizzesTable = document.getElementById('dash-recent-quizzes');
    if (recentQuizzesTable) {
        recentQuizzesTable.innerHTML = '';
        if (!stats.recentQuizzes || stats.recentQuizzes.length === 0) { recentQuizzesTable.innerHTML = `<tr><td colspan="3" class="px-4 py-8 text-center text-slate-500 dark:text-slate-500 text-sm">No quizzes created yet.</td></tr>`; } 
        else { stats.recentQuizzes.forEach(quiz => { recentQuizzesTable.insertAdjacentHTML('beforeend', `<tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"><td class="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(quiz.title)}</td><td class="px-4 py-2.5 text-slate-500 dark:text-slate-400">${escapeHtml(quiz.subject)}</td><td class="px-4 py-2.5 text-center font-semibold text-slate-700 dark:text-slate-300"><span class="text-blue-600 dark:text-blue-400">${quiz.uploaded_count}</span> <span class="text-slate-400 dark:text-slate-500 text-xs">/ ${quiz.items}</span></td></tr>`); }); }
    }

    const recentActivityList = document.getElementById('dash-recent-activity');
    if (recentActivityList) {
        recentActivityList.innerHTML = '';
        if (!stats.recentActivity || stats.recentActivity.length === 0) { recentActivityList.innerHTML = `<div class="text-center py-6"><p class="text-slate-500 dark:text-slate-500 text-sm font-medium">No recent activity recorded.</p></div>`; } 
        else { stats.recentActivity.forEach(act => { recentActivityList.insertAdjacentHTML('beforeend', `<div class="flex items-start gap-4"><div class="w-8 h-8 rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0 mt-1 border border-purple-100 dark:border-purple-800/50"><i class="fa-solid fa-clipboard-check"></i></div><div><p class="text-sm text-slate-700 dark:text-slate-300 font-medium"><span class="font-bold text-slate-800 dark:text-slate-100">${act.student_name}</span> completed the <span class="font-bold text-slate-800 dark:text-slate-100">${act.quiz_title}</span> exam.</p><p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">${act.date_completed} • Scored ${act.score} points</p></div></div>`); }); }
    }

    const topStudentsList = document.getElementById('dash-top-students');
    if (topStudentsList) {
        topStudentsList.innerHTML = '';
        if (!stats.topStudents || stats.topStudents.length === 0) { topStudentsList.innerHTML = `<div class="text-center py-8"><p class="text-slate-500 dark:text-slate-500 text-sm font-medium">No top scores yet.</p></div>`; } 
        else {
            stats.topStudents.forEach((student, index) => {
                let rankColor = "text-slate-400 dark:text-slate-600"; 
                if(index === 0) rankColor = "text-yellow-500 dark:text-yellow-400"; else if(index === 1) rankColor = "text-slate-300 dark:text-slate-400"; else if(index === 2) rankColor = "text-orange-400 dark:text-orange-500"; 
                topStudentsList.insertAdjacentHTML('beforeend', `<div class="flex items-center justify-between"><div class="flex items-center gap-4"><span class="font-black ${rankColor} w-4 text-center">${index + 1}</span><div class="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xs border border-blue-100 dark:border-blue-800/50 shadow-sm"><i class="fa-solid fa-user"></i></div><div><p class="text-sm font-bold text-slate-800 dark:text-slate-200 leading-tight">${student.student_name}</p><p class="text-[10px] text-slate-500 dark:text-slate-400">${student.student_id}</p></div></div><span class="text-green-500 dark:text-green-400 font-black text-sm">${Math.round(student.percentage)}%</span></div>`);
            });
        }
    }

    const chartCanvas = document.getElementById('passFailChart');
    if (chartCanvas) {
        if (passFailChartInstance) { passFailChartInstance.destroy(); passFailChartInstance = null; }
        const chartHost = chartCanvas.parentElement;
        const emptyState = chartHost ? chartHost.querySelector('[data-chart-empty]') : null;
        if (stats.passed > 0 || stats.failed > 0) { 
            if (emptyState) emptyState.remove();
            chartCanvas.classList.remove('hidden');
            passFailChartInstance = new Chart(chartCanvas, { 
                type: 'doughnut', 
                data: { labels: ['Passed', 'Failed'], datasets: [{ data: [stats.passed, stats.failed], backgroundColor: ['#16a34a', '#dc2626'], borderWidth: 0, hoverOffset: 4 }] }, 
                options:{ animation: false, responsive: true, maintainAspectRatio: false, cutout: '75%', plugins: { legend: { display: false } } } 
            }); 
        } 
        else { 
            chartCanvas.classList.add('hidden');
            if (chartHost && !emptyState) {
                chartHost.insertAdjacentHTML('beforeend', `<div data-chart-empty class="flex items-center justify-center h-full text-slate-400 dark:text-slate-600 text-sm font-bold"><i class="fa-solid fa-chart-pie mr-2"></i> No exam data available yet.</div>`);
            }
        }
    }

    const widgetsContainer = document.getElementById('dashboard-extra-widgets');
    if (widgetsContainer) {
        const atRiskHtml = stats.atRisk 
            ? `<div class="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 p-3 rounded-lg flex items-center gap-3"><div class="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-fire"></i></div><div><p class="text-[10px] uppercase font-bold text-red-400 dark:text-red-500">At-Risk Subject</p><p class="text-sm font-black text-red-700 dark:text-red-300 leading-tight">${stats.atRisk.title}</p><p class="text-xs text-red-500 dark:text-red-400 font-bold">${stats.atRisk.failRate}% Failure Rate</p></div></div>`
            : `<div class="bg-green-50 dark:bg-green-900/10 border border-green-100 dark:border-green-900/30 p-3 rounded-lg flex items-center gap-3"><div class="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-circle-check"></i></div><div><p class="text-[10px] uppercase font-bold text-green-500 dark:text-green-600">System Status</p><p class="text-sm font-black text-green-700 dark:text-green-300 leading-tight">All Subjects Healthy</p></div></div>`;
            
        const totalRecords = stats.students + stats.quizzes + stats.questions + stats.results;
        const healthHtml = `<div class="bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 p-3 rounded-lg flex items-center gap-3 mt-3"><div class="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0"><i class="fa-solid fa-server"></i></div><div><p class="text-[10px] uppercase font-bold text-blue-400 dark:text-blue-500">Database Storage</p><p class="text-sm font-black text-blue-700 dark:text-blue-300 leading-tight">${totalRecords.toLocaleString()} Records Active</p><p class="text-xs text-blue-500 dark:text-blue-400 font-bold">Offline System Secure</p></div></div>`;
        
        widgetsContainer.innerHTML = `${atRiskHtml}${healthHtml}`;
    }
});

setInterval(() => { const adminLayout = document.getElementById('admin-layout'); const dashboardView = document.getElementById('view-dashboard'); if (adminLayout && !adminLayout.classList.contains('hidden') && !dashboardView.classList.contains('hidden')) fetchDashboardStats(); }, 3000);
setTimeout(fetchDashboardStats, 1000);

// --- SETTINGS: ADMINS, BRANDING, SECURITY, AND DATA MANAGEMENT ---

function saveNewAdmin() {
    const userBox = document.getElementById('new-admin-user').value.trim();
    const profileBox = document.getElementById('new-admin-profile').value.trim();
    const passBox = document.getElementById('new-admin-pass').value.trim();
    if (!userBox || !passBox) { alert("Please enter both a username and password."); return; }
    ipcRenderer.send('add-admin', {
        requesterId: getAuthUser().id,
        username: userBox,
        display_name: profileBox,
        password: passBox
    });
}

ipcRenderer.on('load-admins', (event, admins) => {
    adminAccounts = admins || [];
    const tableBody = document.getElementById('admins-table-body');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (adminAccounts.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-slate-500 text-xs">No accounts available.</td></tr>`;
        return;
    }

    adminAccounts.forEach(admin => {
        const isMaster = Number(admin.id) === 1;
        const profileName = normalizeInstructorName(admin.display_name) || admin.username;
        const revealed = revealedAdminPasswords.has(String(admin.id));
        const passwordText = revealed ? String(admin.password || '') : '••••••••';

        const roleBadge = isMaster
            ? `<span class="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-2 py-0.5 rounded text-[10px] font-semibold uppercase border border-slate-200 dark:border-slate-700">Master Admin</span>`
            : `<span class="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded text-[10px] font-semibold uppercase border border-blue-200 dark:border-blue-800/50">Instructor</span>`;

        const revealBtn = `<button onclick="toggleAdminPassword(${admin.id})" class="inline-flex items-center justify-center w-6 h-6 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:border-blue-700 dark:hover:text-blue-300 transition-colors" title="${revealed ? 'Hide' : 'View'} password"><i class="fa-solid ${revealed ? 'fa-eye-slash' : 'fa-eye'} text-[10px]"></i></button>`;
        const editBtn = `<button onclick="prepareEditAdmin(${admin.id})" class="inline-flex items-center justify-center w-7 h-7 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:border-blue-700 dark:hover:text-blue-300 transition-colors" title="Edit account"><i class="fa-solid fa-pen text-[10px]"></i></button>`;
        const deleteBtn = isMaster
            ? `<button type="button" disabled class="btn btn-danger btn-sm" title="Master Account"><i class="fa-solid fa-lock" aria-hidden="true"></i><span class="sr-only">Master account cannot be deleted</span></button>`
            : `<button type="button" onclick="deleteAdmin(${admin.id})" class="btn btn-danger btn-sm" title="Delete Account"><i class="fa-solid fa-trash" aria-hidden="true"></i><span class="sr-only">Delete account</span></button>`;

        tableBody.insertAdjacentHTML('beforeend', `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <td class="px-4 py-2.5">
                    <p class="font-semibold text-slate-800 dark:text-slate-200 leading-tight">${escapeHtml(profileName)}</p>
                    <p class="text-[11px] text-slate-500 dark:text-slate-400">@${escapeHtml(admin.username)}</p>
                </td>
                <td class="px-4 py-2.5">${roleBadge}</td>
                <td class="px-4 py-2.5">
                    <div class="flex items-center gap-2">
                        <span class="font-mono text-xs text-slate-600 dark:text-slate-300">${escapeHtml(passwordText)}</span>
                        ${revealBtn}
                    </div>
                </td>
                <td class="px-4 py-2.5 text-center space-x-1.5 whitespace-nowrap">${editBtn}${deleteBtn}</td>
            </tr>`);
    });
});

function toggleAdminPassword(id) {
    const key = String(id);
    if (revealedAdminPasswords.has(key)) revealedAdminPasswords.delete(key);
    else revealedAdminPasswords.add(key);
    ipcRenderer.send('get-admins', { requesterId: getAuthUser().id });
}

function prepareEditAdmin(id) {
    const admin = adminAccounts.find(a => Number(a.id) === Number(id));
    if (!admin) { alert('Account not found.'); return; }
    document.getElementById('edit-admin-id').value = admin.id;
    document.getElementById('edit-admin-profile').value = normalizeInstructorName(admin.display_name) || admin.username;
    document.getElementById('edit-admin-username').value = admin.username;
    document.getElementById('edit-admin-password').value = '';
    openModal('modal-edit-admin');
}

function saveEditAdmin() {
    const id = document.getElementById('edit-admin-id').value;
    const profile = document.getElementById('edit-admin-profile').value.trim();
    const username = document.getElementById('edit-admin-username').value.trim();
    const password = document.getElementById('edit-admin-password').value;
    if (!username) { alert('Username cannot be empty.'); return; }
    ipcRenderer.send('update-admin', {
        requesterId: getAuthUser().id,
        id,
        username,
        display_name: profile,
        password
    });
}

ipcRenderer.on('admin-save-response', (event, response) => {
    if (response.success) {
        const userBox = document.getElementById('new-admin-user');
        const profileBox = document.getElementById('new-admin-profile');
        const passBox = document.getElementById('new-admin-pass');
        if (userBox) userBox.value = '';
        if (profileBox) profileBox.value = '';
        if (passBox) passBox.value = '';
        closeModal('modal-edit-admin');
        ipcRenderer.send('get-instructor-profiles');
    }
    alert(response.message || (response.success ? 'Saved.' : 'Could not save the account.'));
});

ipcRenderer.on('admin-password-response', (event, response) => {
    alert(response.message || (response.success ? 'Password updated.' : 'Could not update the password.'));
    if (response.success) ipcRenderer.send('get-instructor-profiles');
});

function deleteAdmin(id) {
    customConfirm("Are you sure you want to remove this instructor account?", () => ipcRenderer.send('delete-admin', { id, requesterId: getAuthUser().id }));
}

function handleImageUpload(event, storageKey) { const file = event.target.files[0]; if (file) { const reader = new FileReader(); reader.onload = function(e) { localStorage.setItem(storageKey, e.target.result); applyBranding(); alert("Image applied successfully!"); }; reader.readAsDataURL(file); } }

function applyBranding() {
    const savedLogo = localStorage.getItem('savedLogo'); const savedProfile = localStorage.getItem('savedProfilePic');
    if (savedLogo) { document.querySelectorAll('.fa-graduation-cap').forEach(cap => { const parent = cap.parentElement; parent.classList.remove('p-2'); parent.classList.add('w-12', 'h-12', 'overflow-hidden', 'flex-shrink-0', 'bg-transparent'); parent.innerHTML = `<img src="${savedLogo}" class="w-full h-full object-contain">`; }); }
    if (savedProfile) { document.querySelectorAll('.fa-user').forEach(icon => { const parent = icon.parentElement; if (parent.classList.contains('w-10') && parent.classList.contains('h-10')) { parent.classList.add('overflow-hidden', 'bg-transparent', 'border', 'border-slate-700'); parent.innerHTML = `<img src="${savedProfile}" class="w-full h-full object-cover">`; } }); }
}

function resetBranding() { customConfirm("Are you sure you want to revert to the default icons?", () => { localStorage.removeItem('savedLogo'); localStorage.removeItem('savedProfilePic'); window.location.reload(); }); }
function togglePassword(inputId, iconId) { const input = document.getElementById(inputId); const icon = document.getElementById(iconId); if (input.type === 'password') { input.type = 'text'; icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); } else { input.type = 'password'; icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); } }

ipcRenderer.on('trigger-cheat-alarm', (event, data) => {
    const container = document.getElementById('dash-security-alerts');
    const emptyMsg = document.getElementById('empty-alerts-msg');
    const violationType = data.reason || 'Tab Switch / Left Exam';
    
    if (container) {
        if (emptyMsg) emptyMsg.remove();
        
        container.insertAdjacentHTML('afterbegin', `
            <div class="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/50 rounded-lg relative group">
                <div class="w-8 h-8 rounded-full bg-red-600 dark:bg-red-500/20 text-white dark:text-red-400 flex items-center justify-center shrink-0 shadow-sm text-sm mt-1 animate-pulse"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <div class="flex-1 pr-6">
                    <h4 class="text-red-800 dark:text-red-400 font-black text-xs uppercase tracking-wide">${violationType}</h4>
                    <p class="text-red-900 dark:text-red-300 font-medium mt-0.5 text-xs"><span class="font-bold bg-red-200 dark:bg-red-900/50 px-1 rounded">${data.student_name}</span> flagged during exam.</p>
                    <p class="text-[10px] text-red-700 dark:text-red-500 mt-1 font-bold"><i class="fa-regular fa-clock mr-1"></i> ${data.time} | ${data.quiz_title}${Number(data.incident_count || 0) > 0 ? ` | <span class="uppercase">⚠ Total ${Number(data.incident_count)} warnings</span>` : ''}</p>
                </div>
                <button onclick="this.parentElement.remove(); checkEmptyAlerts();" class="absolute top-2 right-2 text-red-400 hover:text-red-700 dark:hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `);
    }
});

function checkEmptyAlerts() {
    const container = document.getElementById('dash-security-alerts');
    if (container && container.children.length === 0) {
        container.innerHTML = `
            <div class="text-center py-6" id="empty-alerts-msg">
                <div class="w-12 h-12 rounded-full bg-slate-50 dark:bg-slate-800/50 text-slate-300 dark:text-slate-600 flex items-center justify-center text-xl mx-auto mb-2"><i class="fa-solid fa-shield-halved"></i></div>
                <p class="text-slate-500 dark:text-slate-500 text-sm font-medium">No alerts detected.</p>
            </div>
        `;
    }
}

function clearSecurityAlerts() {
    const container = document.getElementById('dash-security-alerts');
    if (container) container.innerHTML = '';
    checkEmptyAlerts();
}

function exportSecurityAlerts() {
    const container = document.getElementById('dash-security-alerts');
    const alerts = container.querySelectorAll('.group'); 
    
    if (alerts.length === 0) {
        alert("No security alerts to save.");
        return;
    }
    
    let logText = "========================================\n";
    logText += "      OFFLINE EXAM - SECURITY LOG\n";
    logText += "      Generated: " + new Date().toLocaleString() + "\n";
    logText += "========================================\n\n";
    
    alerts.forEach(alertDiv => {
        const headingEl = alertDiv.querySelector('h4');
        const studentEl = alertDiv.querySelector('span.bg-red-200, span.dark\\:bg-red-900\\/50');
        const timeEl = alertDiv.querySelector('p.text-\\[10px\\]');
        const violation = headingEl ? headingEl.innerText : 'Security Alert';
        const studentName = studentEl ? studentEl.innerText : 'Unknown Student';
        const timeAndQuiz = timeEl ? timeEl.innerText : '';
        logText += `[${violation}] ${studentName}\n          Details: ${timeAndQuiz}\n\n`;
    });
    
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Security_Log_${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    window.URL.revokeObjectURL(url);
}

function prepareEditStudent(id, studentId, fullName, courseSection, registeredBy) {
    document.getElementById('edit-student-db-id').value = id;
    document.getElementById('edit-student-id-input').value = studentId;
    document.getElementById('edit-student-name-input').value = fullName;
    document.getElementById('edit-student-course-input').value = courseSection;

    const registrarSelect = document.getElementById('edit-student-registrar');
    if (registrarSelect) {
        registrarSelect.innerHTML = registrarOptionsHtml(normalizeInstructorName(registeredBy));
        registrarSelect.value = normalizeInstructorName(registeredBy);
        registrarSelect.dataset.current = 'true';
    }
    populateRegistrarSelects();
    if (registrarSelect) registrarSelect.value = normalizeInstructorName(registeredBy);
    openModal('modal-edit-student');
}

function saveEditStudent() {
    const idBox = document.getElementById('edit-student-db-id').value; const studentIdBox = document.getElementById('edit-student-id-input').value.trim(); const nameBox = document.getElementById('edit-student-name-input').value.trim(); const courseBox = document.getElementById('edit-student-course-input').value.trim();
    if (!studentIdBox || !nameBox || !courseBox) { alert("Please fill in all fields!"); return; }
    const registrarSelect = document.getElementById('edit-student-registrar');
    const registrar = registrarSelect ? registrarSelect.value : '';
    ipcRenderer.send('update-student', { id: idBox, student_id: studentIdBox, full_name: nameBox, course_section: courseBox, registered_by: registrar }); closeModal('modal-edit-student');
}

ipcRenderer.on('student-update-response', (event, response) => { if (response.success) { closeModal('modal-edit-student'); } else { alert(response.message); } });
function jumpToQuestionBank(quizTitle) { switchView('questions'); const dropdown = document.getElementById('question-quiz-select'); if (dropdown) { dropdown.value = quizTitle; fetchQuestions(); } }

function viewItemAnalysis(resultId) {
    const result = currentLoadedResults.find(r => String(r.id) === String(resultId));
    if (!result) {
        alert("Could not find the selected result record.");
        return;
    }

    activeAnalysisResultId = result.id;

    let modal = document.getElementById('modal-item-analysis');
    if (!modal || !document.getElementById('analysis-table-body')) {
        if (modal) modal.remove();
        document.body.insertAdjacentHTML('beforeend', `
            <div id="modal-item-analysis" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm hidden items-center justify-center z-[70] p-4">
                <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
                    <div class="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
                        <div>
                            <h3 class="text-lg font-extrabold flex items-center gap-2">
                                <i class="fa-solid fa-magnifying-glass-chart text-blue-400"></i> Student Item Analysis
                            </h3>
                            <p class="text-xs text-slate-400 mt-0.5">
                                <span id="analysis-student-name" class="font-bold text-white"></span> • 
                                <span id="analysis-quiz-title" class="text-blue-300"></span> • 
                                Score: <span id="analysis-score" class="font-bold text-green-400"></span>
                            </p>
                        </div>
                        <button type="button" onclick="closeModal('modal-item-analysis')" class="text-slate-400 hover:text-white text-xl px-2">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <div class="p-6 overflow-y-auto flex-1">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[11px] font-black uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
                                    <th class="px-4 py-3 text-center w-12">#</th>
                                    <th class="px-4 py-3">Question</th>
                                    <th class="px-4 py-3 text-center">Student Answer</th>
                                    <th class="px-4 py-3 text-center">Correct Answer</th>
                                    <th class="px-4 py-3 text-center w-20">Result</th>
                                </tr>
                            </thead>
                            <tbody id="analysis-table-body"></tbody>
                        </table>
                    </div>
                    <div class="px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
                        <button type="button" onclick="openEditScore(activeAnalysisResultId)" class="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm rounded-lg transition-colors">
                            <i class="fa-solid fa-pen-to-square mr-1"></i>Edit Score
                        </button>
                        <button type="button" onclick="closeModal('modal-item-analysis')" class="btn btn-secondary">
                            Close
                        </button>
                    </div>
                </div>
            </div>
        `);
        modal = document.getElementById('modal-item-analysis');
    } else if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }

    const nameEl = document.getElementById('analysis-student-name');
    const titleEl = document.getElementById('analysis-quiz-title');
    const scoreEl = document.getElementById('analysis-score');
    const container = document.getElementById('analysis-table-body');

    if (nameEl) nameEl.innerText = result.student_name || '';
    if (titleEl) titleEl.innerText = result.quiz_title || '';
    if (scoreEl) scoreEl.innerText = `${result.score} / ${result.total_items}`;
    if (!container) return;

    container.innerHTML = '';

    if (!result.student_answers || result.student_answers === 'null' || result.student_answers === '[]') {
        container.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500 dark:text-slate-500"><i class="fa-solid fa-ghost text-2xl mb-2 text-slate-300 dark:text-slate-600 block"></i> No item analysis data available for this exam record.</td></tr>`;
    } else {
        try {
            let answers = typeof result.student_answers === 'string'
                ? JSON.parse(result.student_answers)
                : result.student_answers;
            if (typeof answers === 'string') answers = JSON.parse(answers);

            if (!Array.isArray(answers) || answers.length === 0) {
                container.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500 dark:text-slate-500">No recorded answers found for this attempt.</td></tr>`;
            } else {
                answers.forEach((ans, idx) => {
                    const qText = ans.question || ans.question_text || `Question ${idx + 1}`;
                    const selectedVal = (ans.selected !== undefined && ans.selected !== null && ans.selected !== '') ? String(ans.selected) : "No Answer";
                    const correctVal = (ans.correct !== undefined && ans.correct !== null) ? String(ans.correct) : "";

                    const isCorrect = selectedVal.trim().toLowerCase() === correctVal.trim().toLowerCase();
                    const statusIcon = isCorrect 
                        ? '<i class="fa-solid fa-check text-green-500 dark:text-green-400 bg-green-100 dark:bg-green-900/30 p-1.5 rounded-full border border-transparent dark:border-green-800/50"></i>' 
                        : '<i class="fa-solid fa-xmark text-red-500 dark:text-red-400 bg-red-100 dark:bg-red-900/30 p-1.5 px-2 rounded-full border border-transparent dark:border-red-800/50"></i>';
                    
                    const rowClass = isCorrect ? 'bg-green-50/30 dark:bg-green-900/10' : 'bg-red-50/30 dark:bg-red-900/10';
                    
                    let selectedText = selectedVal;
                    if (selectedVal === "No Answer") {
                        selectedText = `<span class="text-red-500 dark:text-red-400 font-bold italic border border-red-200 dark:border-red-800/50 px-1 rounded bg-red-50 dark:bg-red-900/30">No Answer</span>`;
                    } else if (!isCorrect) {
                        selectedText = `<span class="text-red-600 dark:text-red-400 font-bold">${selectedVal}</span>`;
                    } else {
                        selectedText = `<span class="text-green-700 dark:text-green-400 font-bold">${selectedVal}</span>`;
                    }

                    container.insertAdjacentHTML('beforeend', `
                        <tr class="border-b border-slate-200 dark:border-slate-800 hover:bg-white dark:hover:bg-slate-800 transition-colors ${rowClass}">
                            <td class="px-4 py-3 text-center font-black text-slate-500 dark:text-slate-400">${idx + 1}</td>
                            <td class="px-4 py-3 font-medium text-slate-800 dark:text-slate-200 leading-snug">${qText}</td>
                            <td class="px-4 py-3 text-center text-sm">${selectedText}</td>
                            <td class="px-4 py-3 text-center font-bold text-slate-700 dark:text-slate-300 text-sm">${correctVal}</td>
                            <td class="px-4 py-3 text-center">${statusIcon}</td>
                        </tr>
                    `);
                });
            }
        } catch (e) {
            container.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-red-500 dark:text-red-400 font-bold">Error loading answer data!</td></tr>`;
        }
    }
    
    openModal('modal-item-analysis');
}

// --- DATA MANAGEMENT SYSTEM ---
function triggerBackup() { 
    ipcRenderer.send('backup-database'); 
}

function triggerRestore() { 
    customConfirm("Are you sure you want to restore the database from a backup file? This will overwrite your current data.", () => { 
        ipcRenderer.send('restore-database'); 
    }); 
}

ipcRenderer.on('restore-success', () => { 
    alert("Database restored successfully! The system will now reload."); 
    setTimeout(() => { window.location.reload(); }, 1500); 
});

function endOfSemesterReset() { 
    customConfirm("WARNING: This will permanently delete ALL Students and Exam Results. Are you absolutely sure?", () => { 
        ipcRenderer.send('end-of-semester-reset'); 
        setTimeout(fetchDashboardStats, 500); 
    }); 
}

// ============================================================================
// HYBRID DUAL-MODE TUNNEL, 3-LAYER PROCTORING BAR & IN-APP UPDATER CONTROLS
// ============================================================================
let isTunnelActive = false;

ipcRenderer.on('app-version-response', (event, version) => {
    const verBadge = document.getElementById('app-current-version');
    if (verBadge && version) verBadge.innerText = `v${version}`;
});

function toggleCloudflareTunnel() {
    const btn = document.getElementById('btn-toggle-tunnel');
    if (!isTunnelActive) {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i> Connecting...`;
        }
        ipcRenderer.send('start-cloudflare-tunnel');
    } else {
        ipcRenderer.send('stop-cloudflare-tunnel');
    }
}

ipcRenderer.on('cloudflare-tunnel-status', (event, data) => {
    const urlBox = document.getElementById('display-cloudflare-url');
    const btn = document.getElementById('btn-toggle-tunnel');
    if (!urlBox || !btn) return;

    btn.disabled = false;

    if (data.status === 'connecting') {
        urlBox.innerText = 'Generating Cloudflare link...';
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i> Connecting...`;
    } else if (data.status === 'online') {
        isTunnelActive = true;
        urlBox.innerText = data.url;
        urlBox.classList.remove('text-slate-500');
        urlBox.classList.add('text-amber-700', 'dark:text-amber-300', 'font-black');
        btn.className = 'btn btn-sm btn-danger shrink-0';
        btn.innerHTML = `<i class="fa-solid fa-power-off mr-1"></i> Stop Global Link`;
    } else if (data.status === 'error') {
        isTunnelActive = false;
        urlBox.innerText = 'Offline (Connection failed)';
        btn.className = 'btn btn-sm btn-secondary shrink-0';
        btn.innerHTML = `<i class="fa-solid fa-bolt mr-1"></i> Enable Global Link`;
        alert(data.message || "Failed to start Cloudflare Tunnel.");
    } else {
        isTunnelActive = false;
        urlBox.innerText = 'Offline (Click Enable to generate link)';
        urlBox.classList.remove('text-amber-700', 'dark:text-amber-300', 'font-black');
        urlBox.classList.add('text-slate-500');
        btn.className = 'btn btn-sm btn-secondary shrink-0';
        btn.innerHTML = `<i class="fa-solid fa-bolt mr-1"></i> Enable Global Link`;
    }
});

function copyPortalLink(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.innerText.trim();
    if (!text.startsWith('http')) {
        alert("Please wait for or enable the link first before copying.");
        return;
    }
    try {
        if (typeof clipboard !== 'undefined' && clipboard.writeText) {
            clipboard.writeText(text);
        } else {
            const tempInput = document.createElement('textarea');
            tempInput.value = text;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand('copy');
            document.body.removeChild(tempInput);
        }
        alert("Success! Portal link copied to clipboard:\n" + text);
    } catch (err) {
        alert("Could not copy automatically: " + text);
    }
}

// --- 3-LAYER PROCTORING BAR & AUTO-LOCK CONTROLS ---
function injectAutoLockControl() {
    const lockBtn = document.getElementById('btn-gatekeeper-lock');
    if (lockBtn && !document.getElementById('auto-lock-target-input')) {
        lockBtn.parentElement.classList.add('flex-wrap');
        lockBtn.insertAdjacentHTML('beforebegin', `
            <div class="flex items-center gap-2 bg-slate-800 border border-slate-700 px-3 py-2 rounded-xl" title="Auto-lock room & retire PIN once this many logged-in students unlock the exam (0 = Manual Lock)">
                <span class="text-[11px] font-bold text-slate-300 whitespace-nowrap"><i class="fa-solid fa-user-check text-emerald-400 mr-1"></i> Auto-Lock At:</span>
                <input id="auto-lock-target-input" type="number" min="0" max="500" value="0" onchange="updateExpectedStudents(this.value)" oninput="updateExpectedStudents(this.value)" class="w-14 bg-slate-950 text-amber-300 font-mono font-black text-xs text-center py-1 px-1.5 rounded border border-slate-700 focus:border-amber-400 outline-none" placeholder="0">
                <span id="unlocked-pin-counter" class="text-[11px] font-mono font-bold text-emerald-400 whitespace-nowrap">0 Unlocked</span>
            </div>
        `);
    }
}

function updateExpectedStudents(val) {
    ipcRenderer.send('set-expected-students', parseInt(val, 10) || 0);
}

function toggleGatekeeperLock() {
    ipcRenderer.send('toggle-gatekeeper-lock');
}

function cycleDynamicPin() {
    ipcRenderer.send('cycle-dynamic-pin');
}

function resetStudentSessionLocks() {
    customConfirm("Reset all active student device locks and PIN redemptions? Use this when starting a new class or if a student switched devices.", () => {
        ipcRenderer.send('reset-student-sessions');
    });
}

ipcRenderer.on('security-state-update', (event, state) => {
    injectAutoLockControl();
    const countBadge = document.getElementById('live-connected-badge');
    const unlockedBadge = document.getElementById('unlocked-pin-counter');
    const targetInput = document.getElementById('auto-lock-target-input');
    const pinDisplay = document.getElementById('display-rolling-pin');
    const pinTimer = document.getElementById('rolling-pin-timer');
    const lockBtn = document.getElementById('btn-gatekeeper-lock');
    const lockIcon = document.getElementById('gatekeeper-icon');
    const lockText = document.getElementById('gatekeeper-text');

    if (countBadge) {
        countBadge.innerText = `${state.connectedCount} ${state.connectedCount === 1 ? 'Student' : 'Students'} Inside`;
    }
    if (unlockedBadge) {
        const unlocked = state.unlockedCount || 0;
        const target = state.expectedCount || 0;
        unlockedBadge.innerText = target > 0 ? `${unlocked}/${target} Unlocked` : `${unlocked} Unlocked`;
    }
    if (targetInput && document.activeElement !== targetInput && state.expectedCount !== undefined) {
        targetInput.value = state.expectedCount;
    }
    if (pinDisplay) pinDisplay.innerText = state.dynamicPin || '----';
    if (pinTimer) {
        pinTimer.innerText = state.isLocked ? 'LOCKED' : 'LIVE';
        pinTimer.className = state.isLocked
            ? "text-[10px] font-mono bg-red-900/50 text-red-300 px-1.5 py-0.5 rounded font-bold"
            : "text-[10px] font-mono bg-emerald-900/50 text-emerald-300 px-1.5 py-0.5 rounded font-bold";
    }

    if (lockBtn && lockIcon && lockText) {
        if (state.isLocked) {
            lockBtn.className = "bg-red-600 hover:bg-red-700 text-white px-4 py-2.5 rounded-xl font-bold text-xs transition-colors flex items-center gap-2";
            lockIcon.className = "fa-solid fa-lock";
            lockText.innerText = "Entry Locked (Click to Reopen)";
        } else {
            lockBtn.className = "bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl font-bold text-xs transition-colors flex items-center gap-2";
            lockIcon.className = "fa-solid fa-door-open";
            lockText.innerText = "Room Open (Click to Lock Entry)";
        }
    }
});

// --- IN-APP UPDATER FUNCTIONS ---
function checkForUpdates() {
    const inlineStatus = document.getElementById('update-status-inline');
    if (inlineStatus) inlineStatus.innerText = "Checking for updates...";
    ipcRenderer.send('check-for-updates');
}

function downloadAppUpdate() {
    document.getElementById('btn-download-update').classList.add('hidden');
    document.getElementById('btn-skip-update').classList.add('hidden');
    document.getElementById('update-progress-container').classList.remove('hidden');
    ipcRenderer.send('start-download-update');
}

function installAppUpdate() {
    ipcRenderer.send('quit-and-install-update');
}

function skipAppUpdate() {
    closeModal('modal-app-update');
}

ipcRenderer.on('app-update-event', (event, data) => {
    const inlineStatus = document.getElementById('update-status-inline');
    const titleEl = document.getElementById('update-modal-title');
    const msgEl = document.getElementById('update-modal-message');
    const percentEl = document.getElementById('update-progress-percent');
    const barEl = document.getElementById('update-progress-bar');
    const progressWrap = document.getElementById('update-progress-container');
    const btnDownload = document.getElementById('btn-download-update');
    const btnSkip = document.getElementById('btn-skip-update');
    const btnInstall = document.getElementById('btn-install-update');

    if (data.state === 'checking') {
        if (inlineStatus) inlineStatus.innerText = "Contacting update server...";
    } else if (data.state === 'available') {
        if (inlineStatus) inlineStatus.innerText = `Update v${data.version} is available!`;
        titleEl.innerText = `Update v${data.version} Available!`;
        msgEl.innerText = `A new version (v${data.version}) is ready to download. You can download it now or skip for later.`;
        progressWrap.classList.add('hidden');
        btnDownload.classList.remove('hidden');
        btnSkip.classList.remove('hidden');
        btnInstall.classList.add('hidden');
        openModal('modal-app-update');
    } else if (data.state === 'not-available') {
        if (inlineStatus) inlineStatus.innerText = "Your application is up to date.";
        alert("Your application is already running the latest version!");
    } else if (data.state === 'downloading') {
        if (percentEl) percentEl.innerText = `${data.percent}%`;
        if (barEl) barEl.style.width = `${data.percent}%`;
    } else if (data.state === 'downloaded') {
        if (inlineStatus) inlineStatus.innerText = `Update v${data.version} downloaded and ready to install.`;
        titleEl.innerText = "Update Finished!";
        msgEl.innerText = "Download complete. Click 'Restart & Apply' to close the app and apply the update.";
        if (percentEl) percentEl.innerText = "100%";
        if (barEl) barEl.style.width = "100%";
        btnDownload.classList.add('hidden');
        btnSkip.classList.remove('hidden');
        btnSkip.innerText = "Later";
        btnInstall.classList.remove('hidden');
    } else if (data.state === 'dev-mode') {
        if (inlineStatus) inlineStatus.innerText = data.message;
        alert(data.message);
    } else if (data.state === 'error') {
        if (inlineStatus) inlineStatus.innerText = "Could not check for updates.";
        alert("Update Notice: " + data.message);
    }
});