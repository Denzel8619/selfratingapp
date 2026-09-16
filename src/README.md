# Behavior Tracker

A personal daily-behavior rating app. You define your own rules — daily habits, numeric metrics, and weekly goals — rate yourself against them each day, and track the trend over time. An AI coach reviews your recent activity and delivers a short, specific "Today's Plan" focus card each day — streaks, deadlines, weekly trend, and an evolving reflection question — to help you course-correct before small slips become patterns.

## App Scope

Behavior Tracker helps you turn vague self-improvement intentions into a measurable daily routine:

- **Rate My Day** — check off daily yes/no habits, log numeric values (e.g. hours slept, pages read), and track weekly-count goals, all against rules you define yourself.
- **Rules Editor** — create, edit, and archive the habits/goals you're tracking, including goal type (daily, weekly, numeric) and scoring.
- **History** — charts and a heatmap of past ratings so you can see trends, streaks, and where you're consistently falling short.
- **Weekly Summary** — a rolled-up view of the week's performance across all rules.
- **Focus Timer** — a built-in timer for focused work/study sessions.
- **Deadlines** — track upcoming deadlines with a badge count so nothing slips through unnoticed.
- **AI Daily Plan** — a multi-bullet "Today's Plan" card generated each morning: a streak/momentum callout, an upcoming-deadline callout, a weekly trend/grade callout, and an evolving reflection question you answer via your day's note (see below).

The app runs both as a web app and as a desktop app (via Electron), backed by Firebase for auth, data storage, and hosting.

## Tech Stack

- **Frontend:** React 19 + Vite, [Recharts](https://recharts.org/) for data visualization
- **Desktop:** Electron (wraps the same React app for a native desktop build)
- **Backend / Infra:** Firebase — Authentication (Google sign-in), Cloud Firestore (per-user rules/ratings/nudges), Cloud Functions (Node.js), and Firebase Hosting
- **AI:** Google Gemini (`@google/generative-ai`), called from a Firebase Cloud Function
- **Tooling:** ESLint

## How AI Helps Analyze Daily Behavior and Improve Decisions

Each day, a Cloud Function (`dailyNudge` / `dailyNudgeScheduled` in `functions/index.js`) gathers four kinds of grounding data server-side: ~30 days of rating history (to detect per-rule and "Positive Launcher" streaks), upcoming `deadlines`, a live-computed weekly grade (same S–D formula as the Weekly Summary view, plus a trend vs. last week), and the previous day's cached reflection question together with what you wrote in that day's note (your answer). Those facts — not raw data — are sent to **Gemini**, which is prompted to act as a terse, upbeat coach and return five short labeled lines: a streak callout, a deadline callout, a weekly-trend callout, an acknowledgment of your last answer, and a fresh open-ended reflection question. The app renders these as a "Today's Plan" card; a category is omitted whenever there's genuinely nothing to say (no active streak, no near deadline, no days logged yet this week).

This closes the loop between tracking and acting:

1. **Pattern grounding** — because the prompt is built from real streak/deadline/weekly-grade facts computed from your actual data, the plan reflects real patterns instead of generic advice, and the backend re-nulls any bullet whose underlying fact was empty so the model can't invent specifics.
2. **Timely delivery** — plans are pre-generated every morning by a scheduled function (and cached per user/day in Firestore) so the card is ready the moment you open the app, encouraging same-day corrective action rather than after-the-fact reflection.
3. **An evolving conversation** — the reflection question is answered by writing in your day's note; the next morning's plan reads that note back, acknowledges it, and asks something new, so the coach carries a running thread instead of a one-off line.
4. **Efficient reuse** — results are cached per user per day so the same plan isn't regenerated (or re-billed) if the app is reopened multiple times in a day.

Over time, this turns the app's historical data (via the History and Weekly Summary views) plus the AI's daily framing into a feedback loop: track → get a targeted plan → adjust the day's decisions and answer the day's question → see both reflected in tomorrow's plan.

## Project Structure

```
src/
  App.jsx                 # Tab navigation + auth gate
  firebase.js              # Firebase app/auth/functions init
  components/
    RateMyDay.jsx          # Daily rating UI + AI "Today's Plan" focus card
    RulesEditor.jsx         # Define/edit tracked habits & goals
    HistoryCharts.jsx       # Trend charts + heatmap
    WeeklySummary.jsx       # Weekly roll-up view
    FocusTimer.jsx          # Focus/study session timer
    Deadlines.jsx           # Deadline tracking
    Login.jsx               # Google sign-in
  hooks/
    useDeadlines.js
electron/                  # Electron main/preload for the desktop build
functions/
  index.js                 # Cloud Functions: dailyNudge (Gemini) + scheduler
```

## Getting Started

```bash
npm install
npm run dev            # run the web app (Vite dev server)
npm run electron:dev   # run the desktop (Electron) build in dev mode
npm run build           # production build
```

Firebase Functions live in `functions/` and require a `GEMINI_API_KEY` secret configured via Firebase (`firebase functions:secrets:set GEMINI_API_KEY`) to enable the AI daily nudge.
