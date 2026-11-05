# Daycraft

*A little structure. A little more space.*

Daycraft is a calm weekly planner. It comes with a small group page where people keep each other accountable.

## Features

**Full Planner** (`/`) runs in the browser and saves to `localStorage`:
- A week calendar with rows for **Focus**, **Priorities** and **Anytime**, plus an hourly grid with drag and drop.
- Tasks for a specific day or for a whole week, with repeats (daily, weekdays, weekly, custom days).
- An **Agenda** layout with a month date picker and quick ranges.
- Habit tracking with weekly minimums, daily and weekly streaks, and a 52-week progress grid.
- A colour-coded focus label for each day.
- JSON export and import for backups.
- Keyboard navigation: ← / → moves by day, ⌘/Ctrl + ← / → moves by week.

**Boards** (`/boards`) adds Scrum and Kanban project boards. Like the planner, they run in the browser and save to `localStorage`.
- **Projects**: create as many as you need, each using either Scrum or Kanban. You can rename, reorder and add workflow columns, and give any column except Done a WIP limit.
- **Cards**: each card has a type (story, task, bug, spike, chore), priority, story points (Fibonacci), assignee, labels, due date, checklist or acceptance criteria, and a blocked flag with a reason. Cards move by drag and drop or with the ‹ › buttons. You can search, filter by type, assignee or label, and group the board into swimlanes by assignee, priority or type.
- **Scrum**
  - *Backlog*: an ordered product backlog. Drag items into planned sprints; the backlog shows capacity against average velocity and counts unestimated items. Quick-add lets you type a new item and its points in one line.
  - *Sprints*: each sprint has a name, goal, dates and optional capacity. Only one sprint can be active at a time. Completing a sprint records velocity and lets you move unfinished items back to the backlog or into a planned or new sprint.
  - *Sprint board*: shows progress and time elapsed alongside the workflow columns.
  - *Reports*: a burndown chart (ideal against remaining points), a velocity chart (committed against completed), the say/do ratio, and sprint history.
  - *Ceremonies*: daily scrum notes (yesterday, today, blockers) with a list of blocked cards, and a retrospective board (went well, to improve, action items).
- **Kanban**
  - *Board*: WIP limits turn a column amber at the limit and red above it, and each card shows how many days it has been in its current column. Done cards can be archived and restored.
  - *Flow metrics*: work in progress, throughput over 7 and 30 days, average and 85th percentile cycle time, lead time, blocked count, a 30-day cumulative flow diagram, weekly throughput, and a list of the oldest work in progress.
- **Planner integration**: **📅 Add to planner** turns any card or retro action item into a Daycraft planner task, and an open planner tab updates straight away.
- Boards have their own JSON export and import, and the first visit includes example Scrum and Kanban projects.

**My Group** (`/circle`) is backed by the server:
- No accounts. Each member claims a spot (10 by default) and gets a private editing link, a 64-character hex key that is only ever stored as a SHA-256 hash.
- Each member sets one weekly commitment and a target number of sessions, then records dated check-ins (completed, partial, skipped, paused or rescheduled).
- A private schedule for the commitment, with one-time export to Google Calendar, Outlook or an `.ics` file.
- Public comments, and reflections that stay private unless the member chooses to share them.
- The planner page shows a banner with the member's current group commitment.

## Run locally

Requires Node 20 or later. There are no dependencies.

```bash
npm start
```

Open http://localhost:3000.

```bash
npm test
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_FILE` | `./data/circle.json` | Where My Group data is stored |
| `CIRCLE_CAPACITY` | `10` | Number of group spots |

## Deploy

```bash
docker build -t daycraft .
```

```bash
docker run -p 3000:3000 -v daycraft-data:/data daycraft
```

Any Node host with a persistent disk will work. The planner pages are fully static, so `public/` can also be hosted on its own; only My Group needs the server.

## Project layout

```
server.js        Static file server and /api/circle JSON API
public/          Planner, Boards and My Group front end (plain HTML/CSS/JS)
test/            API tests (node:test)
```

## API

Every request is `/api/circle?mode=<mode>&week=<YYYY-MM-DD Monday>`. Requests that change data send `Authorization: Bearer <key>`.

| Mode | Method | Description |
| --- | --- | --- |
| `board` | GET | Public board: members, summaries, 13-week timelines, public check-ins and comments |
| `me` | GET | Your member record, entry (including private schedule) and all your check-ins |
| `claim` | POST | `{name, consent}`: claims a spot for the bearer key |
| `save` | POST | `{action, goal, …, createOnly?}`: creates or updates the commitment for the week |
| `schedule` | POST | `{day, time, duration, timezone}` |
| `log` | POST | `{id, date, status, reflection, shareReflection}`, or `{id, action: "remove" \| "restore"}` |
| `comment` | POST | `{id, targetSlot, text, consent}`, or `{id, action: "remove" \| "restore"}` |
