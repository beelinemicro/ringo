# RINGO 🔴🟡🔵🟢

*The family board game, invented by Dad — now playable online.*

**Play it now: https://ringo.beelinemicrosystems.com** — create a room, share
the 4-letter code, play together from anywhere.

RINGO is played on a 5×5 board. The columns are lettered **R-I-N-G-O** across the
top, and the rows are numbered **1–5** down the side. Roll two dice — one with
the letters R, I, N, G, O, the other with the numbers 1–5, each with one **★ wild**
face — and place a ring of your color where the letter and number meet. The first
player to line up **five rings in a row** (across, down, or diagonally) shouts
**"RINGO!"** and wins.

## Playing

```bash
npm install
npm start
```

Then open **http://localhost:3000**. Three ways to play:

- **Pass & Play** — 2–4 players sharing one screen
- **Play vs Computer** — you against 1–3 computer players
- **Play Online** — one player creates a room and shares the 4-letter code;
  everyone else joins with it. Up to 4 players, each on their own device.

## Rules

1. Each player takes a ring color: **Red**, **Yellow**, **Blue**, or **Green**.
2. On your turn, roll both dice. Place your ring on the space where the rolled
   letter column and number row meet.
3. A **★ wild** on a die lets you choose that coordinate yourself — and a wild
   can **replace an opponent's ring** on any space it reaches, open or not.
   Roll two wilds and the whole board is yours to place or steal.
4. If the rolled space is taken by an **opponent's ring**, you choose: **steal
   the spot** (their ring comes off, yours goes on) or **roll again**. If it's
   your **own ring**, you just roll again. You never lose your turn.
5. First to five same-colored rings in a row — across, down, or diagonal —
   shouts **"RINGO!"** and wins. Thanks to stealing, a full board never ends
   the game — it just gets more cutthroat.

## AWS deployment (ringo.beelinemicrosystems.com)

The live site is fully serverless — effectively $0/month when nobody is playing:

- **Web**: S3 bucket `ringo-web-352154386127-us-east-2` behind CloudFront
  `E18D1UE8BFITPD`, alias `ringo.beelinemicrosystems.com` (Route 53 A/AAAA,
  wildcard ACM cert `*.beelinemicrosystems.com`).
- **Multiplayer**: API Gateway WebSocket API `4bwxqaz8cj` (us-east-2, stage
  `prod`) → Lambda `ringo-ws` (Node 20, `aws/ws-handler/index.mjs` + the shared
  `game.js`) → DynamoDB table `ringo` (on-demand, rooms auto-expire via TTL
  after 24h). The Lambda is authoritative: it rolls the dice and validates
  every placement.

Deploying changes:

```bash
./scripts/deploy-web.sh      # web client → S3 + CloudFront invalidation
./scripts/deploy-lambda.sh   # room server → Lambda
```

`public/js/config.js` is `null` in the repo (online play uses the local
server); the web deploy script overwrites it with the API Gateway `wss://`
endpoint.

**When changing the rules**, bump `GAME_VERSION` in `public/js/game.js` and
deploy both halves. Servers stamp the version on every message; any open page
that hears a newer number shows a "new rules — tap to refresh" banner (with a
confirmation first if the player is mid-game).

## Project layout

```
server.js              Local dev server: serves the game + WebSocket rooms
aws/ws-handler/        Lambda version of the room server (deployed to AWS)
scripts/               Deploy scripts (web + Lambda)
public/index.html      The game page
public/style.css       All visuals
public/js/game.js      Core rules (shared by browser, server.js, and Lambda)
public/js/ai.js        Computer player
public/js/sound.js     Synthesized sound effects (Web Audio, no audio files)
public/js/confetti.js  Win celebration
public/js/config.js    WS endpoint config (rewritten at deploy)
public/js/main.js      Screens, rendering, turn flow, online client
test/game.test.js      Logic tests (npm test)
```

## A note on protecting the game

Dad's instinct to protect RINGO was a good one, and it's not too late — but the
right tool matters: **copyright doesn't cover game rules or mechanics**, only
their creative expression (the rulebook's wording, the board artwork). The name
**RINGO** for a board game would be protected by **trademark**, and the code and
artwork in this repo are automatically copyrighted as they're created. If the
family ever wanted to publish the game, a trademark registration on the name
plus this documented history of the design would be the practical path.
