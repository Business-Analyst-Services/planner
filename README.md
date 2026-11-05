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
public/          Planner and My Group front end (plain HTML/CSS/JS)
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
