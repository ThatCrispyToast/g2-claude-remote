# Claude Remote

Control [Claude Code](https://code.claude.com/docs) remote-control sessions from
[Even Realities G2](https://www.evenrealities.com) glasses: live output,
permissions, dictation, side questions, and session settings. The companion phone
panel also works in a browser without glasses.

<p align="center">
  <img src="assets/store/02-session-live.png" width="70%" alt="A live session streaming on the 576×288 HUD">
</p>

> Parts of this project are AI-generated. The code has been reviewed and tested;
> use at your own discretion.

## Setup

1. Install from [Even Hub](https://hub.evenrealities.com/landing?package_id=com.thatcrispytoast.clauderemote)
   or sideload `claude-remote-<version>.ehpk`.
2. Run the bridge on a machine logged in to Claude Code, using
   [uv](https://docs.astral.sh/uv/):

   ```bash
   uvx --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
   ```

3. Copy the printed URL and token into the phone panel's **Settings**. Use a URL
   your phone can reach; allow port `8790` through the host firewall if needed.

Keep the bridge on a private LAN or Tailscale network. Anyone with the token can
read and control every remote-control session of the logged-in account.
See [bridge documentation](server/README.md) for options and updates.

Optional dictation requires a [Deepgram key](https://console.deepgram.com) in
Settings. English is the default; choose a
[language code](https://developers.deepgram.com/docs/models-languages-overview)
or `multi` for mixed-language speech. Characters outside Latin-1 may not display
on the glasses, but messages send intact.

## Controls

- **Scroll** to select or read. In a session, scroll up for history and down for
  live output.
- **Tap** to open or confirm. Tap session output to open Compose for replies,
  commands, and model, mode, or effort changes.
- **Double-tap** to go back, cancel dictation, or set a prompt aside. Reopen
  deferred prompts from Compose.

Ask aside answers questions without interrupting the session or adding to its
transcript. Each question uses one model call.

## Development

Requires Node 18+ and Python 3.10+.

```bash
git clone https://github.com/ThatCrispyToast/g2-claude-remote && cd g2-claude-remote
npm install
cp .env.example .env.local     # set VITE_BRIDGE_URL / VITE_BRIDGE_TOKEN

npm run bridge                 # port 8790; or use the uvx command above
npm run dev                    # port 5175; run in another terminal

npx @evenrealities/evenhub-cli qr --url http://<host>:5175 --external
npm run pack                   # creates claude-remote-<version>.ehpk
```

Use a phone-reachable address for `VITE_BRIDGE_URL`. Settings saved in the panel
override [`.env.local` defaults](.env.example); packaged builds exclude those
defaults and use the panel's Settings instead.

Keep versions in `package.json` and `app.json` in sync. To develop
[`claude-rc-api`](https://github.com/ThatCrispyToast/claude-rc-api) alongside the
app, clone it next to this repo and use `npm run bridge:uv`.

## License

[MIT](LICENSE). Not affiliated with Anthropic or Even Realities. The
reverse-engineered Remote Control API may change without notice.
