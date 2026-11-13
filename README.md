# Judge My 𝕏

Reply to a post on X, and an AI agent reads your recent posts, scores your
account out of 10, and roasts you. The full report shows your best and worst
post, what you post about, how your best posts open, and three fixes, and you
can ask the agent follow-up questions. Live at
[judgemyx.com](https://judgemyx.com).

## How it works

Every account gets its own [Omnara](https://www.omnara.com) agent, from the
profile in [`agents/judge.yaml`](agents/judge.yaml).

1. Someone replies to the launch post. [`bot.mjs`](bot.mjs) checks for new
   replies through [twitterapi.io](https://twitterapi.io). A plain reply
   judges its author; a reply that tags someone judges the first person
   tagged.
2. [`xdata.mjs`](xdata.mjs) pulls the account's profile and up to 200 recent
   posts and works out its stats. Consistency and engagement are computed from
   those numbers, so they don't change between runs.
3. [`judge.mjs`](judge.mjs) starts an agent with the profile, the stats and
   the account's own posts. It has three custom tools: `list_posts` to dig
   into the best posts, flops and replies, `set_topics` to group posts by
   topic and see how each topic performs, and `submit_report`. Omnara doesn't
   run custom tools itself: the server sees each call on the agent's event
   stream, answers it, and checks the report before accepting it.
4. The bot replies from your account with the score and a link to the
   report. X shows the share card, drawn by [`card.mjs`](card.mjs), as the
   link preview.
5. The agent stays around. Questions asked on the report page go to the same
   agent, which answers with everything it already read.

Everything the agent writes goes through OpenAI's free moderation endpoint
before it's published.

## Run your own

Open this repository in Claude Code, Codex, Cursor, or another coding agent
and say:

```text
Follow SKILL.md to set up Judge My X.
```

Or by hand, with Node 24 or newer:

1. Create an org API key in the [Omnara dashboard](https://app.omnara.com):
   with **All projects** selected, open **Access → API Tokens** and click
   **New token**. Give it the `admin` org role, or the `member` role plus the
   `developer` role on your project.
2. Copy `.env.example` to `.env`. Fill in the Omnara key, your org and
   project IDs, and `X_HANDLE`, the X account that will post the launch
   post. `OPENAI_API_KEY` is optional locally.
3. Run:

   ```sh
   npm install
   npm run setup   # creates the judgemyx-judge profile
   npm start       # http://localhost:8788
   ```

Try it without any X keys on the made-up account in
[`fixtures/`](fixtures):

```sh
curl -X POST localhost:8788/api/rate -H 'Content-Type: application/json' \
  -d '{"handle":"demo_founder"}'
```

Then open `http://localhost:8788/@demo_founder` and watch the agent work.
`/api/rate` only answers requests from the machine the server runs on;
everywhere else, ratings start from replies on X. With `TWITTERAPI_KEY` set,
the same call rates any public account.

## Go live on X

1. In the [X developer console](https://console.x.com), create an app with
   read and write access and add pay-per-use credit. Generate an access token
   and secret for the account in `X_HANDLE`. X's API only lets you reply
   automatically to posts that mention you, and replies to your launch post
   do.
2. Post the launch post with a link to your site, so X shows the site's
   preview card.
3. Set `LAUNCH_POST_ID`, `LAUNCH_POST_URL`, `LAUNCH_POST_TEXT`, the four
   `X_` keys, `TWITTERAPI_KEY`, and `X_POST=1`, then restart.

Without `X_POST=1` the bot only logs what it would reply, in
`data/replies.log`, and marks those replies as handled, so turn it on before
the replies you want answered come in. Replies from `X_HANDLE` itself count
too, but only direct replies to the launch post, so the bot never answers
its own replies. Each check for new replies is a paid twitterapi.io request:
raise `BOT_POLL_SECONDS` once the launch quiets down.

## Deploy

[`fly.toml`](fly.toml) runs the server on [Fly.io](https://fly.io) with a
volume for ratings and cards. Run `npm run setup` first, because the image
includes `agents/profiles.txt`.

```sh
fly apps create <app-name>
fly volumes create judgemyx_data --app <app-name> --region sjc --size 1
grep -v '^#' .env | grep = | fly secrets import --app <app-name>
fly secrets set --app <app-name> PUBLIC_URL=https://<your-domain>
fly deploy --app <app-name>
```

Settings, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | the request's host | Base URL for report links and cards. Required with `X_POST=1` |
| `CONCURRENCY` | `4` | Ratings that run at once; the rest wait in line |
| `DAILY_LIMIT` | `300` | Ratings per day across the whole site |
| `RATINGS_PER_AUTHOR` | `3` | Ratings one person can ask for per day |
| `QUESTIONS_PER_IP` | `20` | Questions one IP address can ask the agent per hour |
| `BOT_POLL_SECONDS` | `5` | How often the bot checks for new replies |
| `BOT_LOOKBACK_HOURS` | `24` | How far back the bot looks for replies when it starts |
| `UNLISTED` | `demo_founder` | Comma-separated handles kept off the leaderboard |
| `REPO_URL` | none | Adds a **GitHub** link to the nav and a **View the code** button to the How it works page |

Not affiliated with X.
