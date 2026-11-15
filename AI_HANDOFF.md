# Offline Exam System v2.1.4 - Anti-Cheat Calibration

## Current State
The UI is complete. We need to calibrate the anti-cheat sensitivity and add incident logging so teachers are aware of flagged behavior without auto-submitting the exam.

## Calibration Checklist
- [ ] **3-Second Camera Buffer:** In the `face-api.js` logic (`student.html` or `script.js`), change the monitoring interval to `1500ms` (1.5 seconds). Trigger the `modal-face-warning` only if there are **2 consecutive misses** (approx. 3.0 seconds total).
- [ ] **Tab-Switching / Visibility Trap:** Add an event listener for `visibilitychange` and `blur` on the window/document. If the student switches tabs, minimizes the browser, or opens a snipping tool (losing focus), instantly pause the timer, blur the exam, and show a warning modal: "Window focus lost. Please stay on the exam page."
- [ ] **Incident Logging (Teacher Warning):** 
    - Update the database schema to include an `incident_count` (integer) for the student's exam session.
    - Every time the Face Warning or Tab Warning fires, send a silent background request to increment this count by 1.
    - Update the Admin Dashboard's Attendance/Results table to display this tally (e.g., a red "⚠️ 2 Warnings" badge) so the teacher knows the student was flagged. Do NOT auto-submit the exam; just record the infraction.

## Instructions for Active AI Agent
1. Execute the 3-Second Camera Buffer and the Tab-Switching Trap.
2. Implement the background Incident Logging to the SQLite database.
3. Update the Admin UI to display these incident logs clearly to the instructor.
4. **CRITICAL:** Do not remove or alter existing DOM IDs. 
5. Verify syntax and append "⚠️ NOTE FOR ACA ⚠️" when finished.