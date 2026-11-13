---
name: setup-judge-my-x
description: Set up, run, deploy, or launch Judge My X, where an Omnara agent reads an X account's recent posts, scores it out of 10 with a roast, and replies on X with a link to the full report. Use when the user asks to set up, run, deploy, launch, update, or remove Judge My X.
---

# Set up Judge My 𝕏

You are setting up the judge profile from `agents/judge.yaml` in the user's
Omnara project and running the server. The goal: the user has watched an
agent judge an account at `http://localhost:8788`, and, if they want, the
site is deployed and answering replies to their launch post on X.

- Skip anything that's already done, and follow the user's lead on order.
- If a command fails, `npx omnara <command> --help` and
  [docs.omnara.com](https://docs.omnara.com) have the details.
- Never print or commit `.env`; it holds API keys.
- Never post on X yourself. The bot only posts once the user turns it on.

## 1. Fill in `.env`

Copy `.env.example` to `.env`. Then:

1. **Omnara.** Only a person can create an API key. Ask the user to open
   [app.omnara.com](https://app.omnara.com), select **All projects**, open
   **Access → API Tokens**, click **New token**, and pick the `admin` org
   role, or `member` plus the `developer` role on their project. They paste
   the token, org ID and project ID into `.env`. If they're logged in to the
   CLI, `npx omnara whoami --json` and
   `npx omnara projects list --org <org-id> --json` show the IDs.
2. **`X_HANDLE`:** the X account that will post the launch post, without
   the `@`.
3. **`OPENAI_API_KEY`** (optional locally): moderation is free and checks
   everything the agent writes before it's published.
4. **`TWITTERAPI_KEY`** (optional for the demo): a
   [twitterapi.io](https://twitterapi.io) key, needed to judge real accounts.
   New accounts get free credit but are rate limited until they top up.

## 2. Create the judge profile

```sh
npm install
npm run setup
```

It checks that the judge's model is granted to the project, creates or
updates the `judgemyx-judge` profile, and writes `agents/profiles.txt`. If
the model isn't granted, check `npx omnara grant models list --json` and
either change `model.name` in `agents/judge.yaml` to a granted model that's
good with tools, or add it with `npx omnara models create` and
`npx omnara grant models add`.

## 3. Judge an account

Run `npm start`, then judge the made-up account in `fixtures/`, which needs
no X keys:

```sh
curl -X POST localhost:8788/api/rate -H 'Content-Type: application/json' \
  -d '{"handle":"demo_founder"}'
```

Open `http://localhost:8788/@demo_founder` and show the user the agent
working live, then the report and its chat. If `TWITTERAPI_KEY` is set, run
the same call with the user's own handle. `/api/rate` only accepts requests
from the same machine.

## 4. Deploy (optional)

Ask for an app name and a domain, use their Fly account (`fly auth whoami`),
and ask before running any command that creates resources or costs money:

```sh
fly apps create <app-name>
fly volumes create judgemyx_data --app <app-name> --region sjc --size 1
grep -v '^#' .env | grep = | fly secrets import --app <app-name>
fly secrets set --app <app-name> PUBLIC_URL=https://<domain>
fly deploy --app <app-name>
```

The image includes `agents/profiles.txt`, so run `npm run setup` first. For
a custom domain, run `fly certs add <domain> --app <app-name>` and have the
user add the DNS records it prints.

## 5. Go live on X (optional)

The bot answers replies to one launch post. Walk the user through it:

1. In the [X developer console](https://console.x.com), they create an app
   with read and write access, add pay-per-use credit, and generate an
   access token and secret while logged in as `X_HANDLE`. Store the consumer
   key and secret and the access token and secret as the four `X_` values.
2. They post the launch post, with a link to the site so X shows its preview
   card, and send you its URL. The ID is the number at the end.
3. Set `LAUNCH_POST_ID`, `LAUNCH_POST_URL`, `LAUNCH_POST_TEXT` (the post's
   text), and `X_POST=1` on the deployed app and confirm the log says
   `bot watching replies to <id> (live)`.

Turn on `X_POST=1` from the start. With it off, the bot logs what it would
reply in `data/replies.log` and marks those replies as handled, so they never
get a real answer. The bot judges replies from `X_HANDLE` too when they reply
straight to the launch post, so the user can reply first to show how it
works. A reply that tags someone judges the person tagged.

## 6. Wrap up

Tell the user:

- **Costs:** every check for new replies is a paid twitterapi.io request.
  Once replies slow down, raise `BOT_POLL_SECONDS` (to 60, say), or unset
  `LAUNCH_POST_ID` to stop the bot. The site and reports keep working.
- **Remove it:** delete the profile in `agents/profiles.txt` with
  `npx omnara profiles delete <agent-profile-id>`, and on Fly,
  `fly apps destroy <app-name>`.
