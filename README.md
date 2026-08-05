# RINGO 🔴🟡🔵🟢

*The family board game, invented by Dad — now playable online.*

**Play it now: https://ringo.beelinemicrosystems.com** — create a room, share
the invite link, play together from anywhere. On a phone, use *Add to Home
Screen* and it installs like an app.

RINGO is played on a 5×5 board. The columns are lettered **R-I-N-G-O** across the
top, and the rows are numbered **1–5** down the side. Roll two dice — one with
the letters R, I, N, G, O, the other with the numbers 1–5, each with one **★ wild**
face — and place a ring of your color where the letter and number meet. There are
**two ways to win**: line up **five rings in a row** (across, down, or diagonally)
or claim **all four corners** — then shout **"RINGO!"**

## Playing

```bash
npm install
npm start
```

Then open **http://localhost:3000**. Three ways to play:

- **Pass & Play** — 2–5 players sharing one screen
- **Play vs Computer** — you against 1–4 computer players, with a difficulty
  picker (**easy** blunders and rarely steals; **normal** is the classic bot;
  **hard** hunts double threats and steals spitefully)
- **Play Online** — one player creates a room and shares the invite link (or
  the 4-letter code); everyone else joins with a tap. Up to 5 players, each on
  their own device. The host can fill empty seats with computer players and
  tap a bot's badge to set its difficulty.

Online play is built for phones and family patience:

- **Invite links** — the lobby's *Share Invite Link* button texts a
  `?join=CODE` link; opening it lands straight in the room.
- **Seat rejoin** — every seat gets a secret token saved in the browser.
  Backgrounding the phone (even mid-invite-text), locking the screen, or
  losing wifi doesn't cost a seat: the page reclaims it automatically the
  moment it's back, in the lobby or mid-game. Only the *Leave* button truly
  gives up a seat; lobby ghosts are pruned when the game starts.
- **Turn nudges** — vibration when it's your turn; the tab title flashes if
  the page is backgrounded.
- **Emoji reactions** — 🎉 😂 😱 😈 💪 ❤️ fly across every screen in the room.
- **Presence badge** — the menu shows how many people are on the site.
- **Family Hall of Fame** — online wins/losses per name, shown on the menu
  and updated live when any game ends. Bots never make the board.

## Rules

1. Each player takes a ring color: **Red**, **Yellow**, **Blue**, **Green**,
   or **Black**.
2. On your turn, roll both dice. Place your ring on the space where the rolled
   letter column and number row meet.
3. A **★ wild** on a die lets you choose that coordinate yourself — and a wild
   can **replace an opponent's ring** on any space it reaches, open or not.
   Roll two wilds and the whole board is yours to place or steal.
4. If the rolled space is taken by an **opponent's ring**, you choose: **steal
   the spot** (their ring comes off, yours goes on) or **roll again**. If it's
   your **own ring**, you just roll again. You never lose your turn.
5. **Two ways to win**: five same-colored rings in a row — across, down, or
   diagonal — **or all four corners**. Shout **"RINGO!"** Thanks to stealing,
   a full board never ends the game — it just gets more cutthroat.

## Tests

```bash
npm test
```

Two suites, both plain Node (no test framework):

- `test/game.test.js` — the shared rules logic (dice, legality, steals,
  wins including four corners).
- `test/server.test.js` — end-to-end: spawns the real `server.js` on a test
  port (sandboxed to a temp dir, bot pacing accelerated) and drives it with
  real WebSocket clients through presence, the usage log, seat tokens,
  lobby survival after silent drops, rejoin, ghost pruning, bots and
  difficulty levels, reactions, and a full game to a recorded win. The
  Lambda speaks the identical protocol, so this suite is the regression net
  for both halves.

## AWS deployment (ringo.beelinemicrosystems.com)

The live site is fully serverless — effectively $0/month when nobody is playing:

- **Web**: S3 bucket `ringo-web-352154386127-us-east-2` behind CloudFront
  `E18D1UE8BFITPD`, alias `ringo.beelinemicrosystems.com` (Route 53 A/AAAA,
  wildcard ACM cert `*.beelinemicrosystems.com`). Files are uploaded with
  `Cache-Control: no-cache` so browsers always revalidate — without it they
  heuristically cache game.js for hours and can play by stale rules. The
  service worker (`public/sw.js`) is network-first with cache fallback:
  installable, offline for local modes, never stale online.
- **Multiplayer**: API Gateway WebSocket API `4bwxqaz8cj` (us-east-2, stage
  `prod`) → Lambda `ringo-ws` (Node 20, 256 MB, **30s timeout** so paced bot
  turns can play out; `aws/ws-handler/index.mjs` + the shared `game.js` and
  `ai.js`) → DynamoDB table `ringo` (on-demand). The Lambda is authoritative:
  it rolls the dice, validates every placement, and plays the bots.

One DynamoDB table, keyed on `pk`:

| Item            | Purpose                              | Lifetime            |
| --------------- | ------------------------------------ | ------------------- |
| `ROOM#<code>`   | room + game state (optimistic `rev`) | TTL 24h after last write |
| `CONN#<id>`     | connection → room/seat lookup        | TTL 24h             |
| `PRESENCE#<id>` | one per open page ("here now" count) | TTL 15min, ping-refreshed |
| `LOG#<utc>#<id>`| usage log: UTC + Central time, IP    | permanent           |
| `STAT#<name>`   | hall-of-fame wins/losses             | permanent           |

The Lambda's role (`ringo-ws-role`, inline policy `ringo-ws-access`) needs
`dynamodb:GetItem/PutItem/DeleteItem/UpdateItem/Scan` on the table plus
`execute-api:ManageConnections`.

Deploying changes:

```bash
./scripts/deploy-web.sh      # web client → S3 + CloudFront invalidation
./scripts/deploy-lambda.sh   # room server → Lambda (bundles game.js + ai.js)
./scripts/usage-log.sh       # print the visit log (with IP geolocation)
```

`public/js/config.js` is `null` in the repo (online play uses the local
server); the web deploy script overwrites it with the API Gateway `wss://`
endpoint.

**When changing the rules**, bump `GAME_VERSION` in `public/js/game.js` and
deploy both halves. Servers stamp the version on every message — including
the presence messages sent on page load — so any open page that hears a newer
number shows a "new rules — tap to refresh" banner (with a confirmation first
if the player is mid-game).

## Project layout

```
server.js              Local dev server: game hosting, rooms, presence, bots,
                       usage.log + stats.json (both gitignored)
aws/ws-handler/        Lambda version of the room server (deployed to AWS)
scripts/               Deploy scripts (web + Lambda) + usage-log viewer
public/index.html      The game page, rules, and the Story of RINGO
public/style.css       All visuals
public/js/game.js      Core rules (shared by browser, server.js, and Lambda)
public/js/ai.js        Computer player (easy / normal / hard), shared too
public/js/sound.js     Synthesized sound effects (Web Audio, no audio files)
public/js/confetti.js  Win celebration
public/js/config.js    WS endpoint config (rewritten at deploy)
public/js/main.js      Screens, rendering, turn flow, online client, presence
public/manifest.json   PWA manifest (home-screen install)
public/sw.js           Service worker: install + offline local play
public/icons/          App icons (generated: five rings, quincunx)
test/game.test.js      Rules logic tests
test/server.test.js    End-to-end room-server tests        (npm test runs both)
```

## A note on protecting the game

Dad's instinct to protect RINGO was a good one, and it's not too late — but the
right tool matters: **copyright doesn't cover game rules or mechanics**, only
their creative expression (the rulebook's wording, the board artwork). The name
**RINGO** for a board game would be protected by **trademark**, and the code and
artwork in this repo are automatically copyrighted as they're created. If the
family ever wanted to publish the game, a trademark registration on the name
plus this documented history of the design would be the practical path.
