# Private website deployment

## Current state

The Next.js site and owner-only authorization code are prepared locally. No deployment has been created, no Google OAuth consent has occurred, and no production secrets have been entered. Deployment requires the owner to use their Google, hosting, and Atlas accounts. The owner-only policy must remain enabled in every environment.

## Google website sign-in

Create a separate Google OAuth client for website sign-in:

1. In Google Cloud Console, configure the OAuth consent screen and enable only the OpenID Connect identity scopes: `openid`, `email`, and `profile`. Do not add Gmail scopes to this client.
2. Create an OAuth client with application type **Web application**.
3. Once the website's final HTTPS hostname is known, add this exact authorized JavaScript origin: `https://YOUR-HOSTNAME`.
4. Add this exact authorized redirect URI: `https://YOUR-HOSTNAME/api/auth/callback/google`.
5. If the consent screen is in testing mode, add the exact owner Google account as a test user. Keep the app unpublished unless there is a deliberate later decision to publish it.

The website callback accepts a verified Google email only when it matches `GRADREACH_OWNER_EMAIL`. A missing or invalid owner email denies access. The sign-in page is public so the owner can start login; all other pages and API requests are protected. There is no account creation or invitation route.

## Private hosting settings

Vercel is a prepared option for this Next.js app; it is not yet linked or deployed. For the production environment, configure these values in the hosting provider's private environment-variable settings. Do not add them to Git, client code, `NEXT_PUBLIC_*`, or chat.

| Variable | Value to enter privately |
|---|---|
| `GRADREACH_OWNER_EMAIL` | The exact Google account email allowed to sign in. |
| `AUTH_GOOGLE_ID` | Client ID from the website's Google OAuth **Web application** client. |
| `AUTH_GOOGLE_SECRET` | Client secret from that same Web application client. |
| `AUTH_SECRET` | A newly generated random secret, unique to this production app. |
| `AUTH_URL` | The final canonical origin, exactly `https://YOUR-HOSTNAME`, without a path. |
| `AUTH_TRUST_HOST` | `true` only when deployed behind the hosting provider's trusted proxy, as intended here. |
| `MONGODB_URI` | The existing working application URI, entered in the hosting secret store; do not paste it into chat or source. |
| `MONGODB_DATABASE` | `gradreach`. |
| `OUTREACH_SENDING_ENABLED` | Leave unset or set to `false`; this website does not send mail. |

Optional provider credentials may be added server-side only when you want their explicit website actions available:

- `SEARCH_PROVIDER_API_KEY` enables one manually requested Brave discovery operation at a time, capped at three results and checked against the documented exact-host allowlist.
- `LLM_PROVIDER_API_KEY` and optional `LLM_PROVIDER_MODEL` enable manually requested evidence triage. The action sends bounded official-source excerpts and configured research criteria to Gemini; it never approves a lead.

Do not configure production credentials in Preview or other untrusted environments. Use a separate isolated database and separate OAuth client if a preview environment is needed. The MongoDB URI and Google OAuth client secret are read only by server code. The browser receives neither.

## Hosting and Atlas network

Connect the repository to the hosting account, select the production branch and final domain, and use the standard Next.js build (`npm run build`) and start (`npm run start`) commands with Node.js 22. Set the production environment variables only after the domain is fixed so `AUTH_URL` and the Google redirect URI match it exactly.

Atlas must accept connections from the deployed server. Vercel's default outbound addresses are dynamic. Vercel documents [Static IPs](https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address) for Pro and Enterprise plans; enable the feature for the selected function region, then add only the assigned egress addresses to the Atlas IP access list. Do not use a broad `0.0.0.0/0` rule. If the hosting account cannot provide stable egress at an acceptable plan/cost, choose a host with fixed outbound IPs before deployment. No Atlas IP rule has been changed by this work.

Ensure the `gradreach` database already contains the `primary` applicant profile and existing GradReach collections before directing the site to it. The website uses `connectMongoStorage`, including the discovery collection migration guard, and only connects from authenticated server operations. Do not point Preview at production data.

## Gmail remains separate

Website Google sign-in requests only identity scopes. It does not connect Gmail, receive Gmail tokens, or enable delivery. The existing local Gmail connection uses its separate Desktop OAuth client, the `gmail.send` scope, state/PKCE checks, and the private local token file. Complete `npm run gmail:connect` locally in the owner browser when ready. That existing token file is not automatically deployed or copied to the website.

The website can review drafts, record explicit approval, plan queue rows, pause the queue, and display delivery status. It has no direct email-send action. `npm run outreach:scheduler` is a long-running worker, not a Next.js serverless request; do not deploy it as a web function. Any later production sender needs its own approved hosting and secure Gmail-token design. Keep sending disabled until that is deliberately implemented and explicitly authorized. No real email is sent by website sign-in, approval, or queue planning.

## Owner actions still required

1. Choose the production host/account and final HTTPS hostname.
2. Create the Google OAuth Web client and enter its values privately in production hosting settings.
3. Enter the exact owner email and generate/enter a production-only `AUTH_SECRET` privately.
4. Confirm or configure stable outbound IPs for the host and have the Atlas administrator allow only those exact addresses.
5. Confirm the `primary` GradReach profile exists in the `gradreach` database.
6. Complete separate Gmail browser consent locally when desired. This is not required to sign in to the website and does not authorize sending.

Do not send secrets to the repository or chat. After these steps, run an owner sign-in check, verify a second Google account is denied, verify unauthenticated page/API/action access is denied, and verify website sign-in has not enabled Gmail. Deployment and live OAuth remain unverified until those checks are performed against the chosen host.
