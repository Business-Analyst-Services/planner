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

**Boards** (`/boards`) adds Scrum and Kanban project boards. Projects are saved in the browser until you share them.
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
- **Shared boards with named members**: **🔗 Share** puts a project on the server. You become its owner and can invite people by name.
  - **Roles**: *owners* manage members and links, *editors* change the board, and *viewers* can only look. Owners can change roles, and a board always keeps at least one owner.
  - **Personal links**: each member gets their own private link, shown once when they're invited. It identifies them, so card edits show "Last edited by …" and the Team dialog shows when each person was last active.
  - **Link rotation**: owners can reset anyone's link and anyone can reset their own; the old link stops working straight away. Owners can also remove members.
  - **Public view-only link**: optional, for stakeholders. It can be turned on, reset or turned off at any time.
  - **Recent activity**: a log of who added, changed or removed cards, sprints, members and links.
  - Changes sync every few seconds and are merged card by card, so people editing different cards never overwrite each other. Edits made offline sync when you reconnect.
  - "Delete for everyone" removes the board from the server. Anyone whose link stops working keeps a local copy.
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
| `DATA_FILE` | `./data/daycraft.json` | JSON file used when Redis isn't configured |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | – | Upstash Redis REST credentials (also accepts `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) |
| `DAYCRAFT_PREFIX` | `daycraft:` | Prefix for Redis keys, so the store can be shared safely |
| `BOARDS_MAX_BYTES` | `1000000` | Maximum size of one shared board |
| `CIRCLE_CAPACITY` | `10` | Number of group spots |
| `BOARDS_MAX_PROJECTS` | `500` | Maximum number of shared boards on the server |

## Deploy

### Vercel (recommended)

The repository is ready for Vercel: `public/` is served as static files, `api/circle.js` and `api/boards.js` run as functions, and `vercel.json` sets clean URLs (`/boards`, `/circle`) and security headers.

Vercel functions can't keep files between requests, so My Group and shared boards store their data in **Upstash Redis**:

1. Import the GitHub repository into Vercel. No build settings are needed.
2. In the Vercel project, go to **Storage → Create Database → Upstash for Redis** (the free plan is enough for a pilot) and connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project's environment variables.
3. Redeploy. Until a store is connected, the planner and local boards still work, and the server features reply "Storage is not configured".

Redis writes use compare-and-set, so simultaneous requests from different function instances never overwrite each other. Each open shared board checks for changes every 8 seconds while its tab is visible. Keep that in mind against Upstash's free command allowance if many people keep boards open all day.

### Docker or any Node host

```bash
docker build -t daycraft .
```

```bash
docker run -p 3000:3000 -v daycraft-data:/data daycraft
```

Without Redis settings, data goes to a JSON file (`DATA_FILE`). If you set `KV_REST_API_URL` and `KV_REST_API_TOKEN`, the Node server uses Redis instead. A data file from the first version is migrated automatically.

## Project layout

```
server.js        Node server for local use and Docker (static files + API)
api/             Vercel functions for /api/circle and /api/boards
lib/core.js      Request handling shared by both
lib/circle-api.js  My Group logic
lib/boards-api.js  Shared boards: members, roles, links, patches
lib/storage.js   JSON-file and Upstash Redis storage with compare-and-set
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

### Shared boards API

Every request is `/api/boards?mode=<mode>&id=<board id>` with `Authorization: Bearer <key>`. Keys are 64 hex characters generated in the browser, and only their SHA-256 hashes are stored. A member's key identifies that member. The optional public key gives anonymous read-only access.

| Mode | Method | Who | Description |
| --- | --- | --- | --- |
| `create` | POST | anyone | `{doc, name}`: shares a project; the key becomes the owner's personal key |
| `get` | GET | any member or public link | Returns `{rev, role, me, members, activity, viewLink, doc}`. Add `&since=<rev>` to get `{unchanged: true}` when nothing has changed |
| `patch` | POST | owner, editor | `{baseRev, ops}` where `ops = {set: {name, sprintDays, columns}, upsert: {cards, sprints, standups}, remove: {…}}`. Applies to the latest revision and stamps `updatedBy` on cards |
| `invite` | POST | owner | `{name, role, key}`: adds a member (names are unique) |
| `member` | POST | owner | `{memberId, role?, name?, remove?}`. A board always keeps at least one owner |
| `rotate` | POST | owner, or a member for themselves | `{memberId?, key}`: replaces that member's key, and the old link stops working |
| `viewlink` | POST | owner | `{action: "enable" \| "rotate" \| "disable", key?}` for the public view-only link |
| `leave` | POST | member | Leaves the board. The last member leaving deletes it |
| `delete` | POST | owner | Deletes the board for everyone |

The server cleans all board data before saving it: unknown fields are dropped, text is length-capped, ids are checked, and sizes are limited.
