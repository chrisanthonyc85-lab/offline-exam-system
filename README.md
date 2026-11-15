# 🎓 Offline Exam System (OES)
**Version 2.1.4 - Production Release**

A resilient, offline-first examination platform engineered for university environments. Designed to operate flawlessly on local networks, OES combines advanced behavioral proctoring with a zero-data-loss fail-safe to guarantee exam integrity even during network outages.

---

## 🚀 Key Features

### 🛡️ Advanced Proctoring & Anti-Cheat
*   **Calibrated Face Tracking (3.0s Rule):** Utilizes computer vision to monitor the student's presence. Built with a specialized tolerance buffer that allows for natural micro-movements but instantly flags the session if the face is obscured for exactly 3.0 seconds (preventing secondary device usage).
*   **Tab-Switching & Focus Traps:** Integrates `visibilitychange` detection to instantly blur the exam and pause the timer if a student attempts to switch browser tabs, open the Start menu, or launch a screen-clipping tool.
*   **Silent Incident Logging:** Suspicious behavior triggers a silent background network request, tallying an `incident_count` in the database. Instructors are alerted via a real-time warning badge on the Admin Dashboard without prematurely aborting the student's exam.

### 🌐 Network Resilience
*   **Zero-Data-Loss Fail-Safe:** If the local campus network drops at the exact moment of submission, the system intercepts the error, securely caches the student's answers and timer in `localStorage`, and provides a seamless recovery mechanism once the connection is restored.

### 🧑‍🏫 SaaS-Grade Instructor Dashboard
*   **Smart Exam Routing:** Dynamic visibility filtering ensures students only see exams specifically assigned to their course section or uploaded by their designated instructor.
*   **Minimalist UI:** A complete flat-design architectural overhaul featuring high-contrast typography, zero-latency roster filtering, and real-time security telemetry.
*   **Non-Destructive Architecture:** SQLite database operations are designed to automatically update schemas on legacy machines without overwriting historical student records or grades.

---

## 🛠️ Tech Stack
*   **Backend:** Node.js, Express.js
*   **Database:** SQLite3 (Local, Offline-First)
*   **Frontend:** Semantic HTML5, CSS3, Vanilla JavaScript
*   **Proctoring:** Face-api.js

---

## 👨‍💻 Project Context
Developed and maintained by **Chris Anthony C. Academia** as part of the 2026–2027 On-the-Job Training (OJT) practicum for the **College of Industrial Technology (CIT), Negros Oriental State University (NORSU) - Bayawan-Sta. Catalina Campus**.

This system is built specifically to address the unique networking and hardware constraints of modern campus testing environments.
