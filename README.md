# @saltcorn/google-calendar

A Google Calendar table provider and action set for Saltcorn. Events and
calendars become ordinary Saltcorn tables you can build views on, and five
actions let triggers and workflows write back.

This is a data-layer module: it adds table providers and actions, and no UI of
its own. An events table renders in `@saltcorn/fullcalendar` without any
further configuration.

## Setup

The plugin's configuration page shows the exact redirect URI to register, and
updates it as you type the base URL — so open it first and work from there.

### 1. Open the plugin configuration and fill in the base URL

Enter this Saltcorn instance's public URL. The page then shows the redirect URI
you need in the next step, in the shape:

```
<your base URL>/google-calendar/oauth2/callback
```

Until the base URL is filled in, the page shows a placeholder host and says so.
Only the value shown once your base URL is in place is the one to register.

`http://localhost:3000` is fine for development. Localhost is the one exception
to Google's HTTPS requirement for redirect URIs.

### 2. Set up the Google Cloud project

In the [Google Cloud console](https://console.cloud.google.com/):

1. **Enable the Google Calendar API** for your project
   ([direct link](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)).
   Nothing else works until this is on — an otherwise correct setup fails with
   a 403 naming the API.
2. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID**
   of type **Web application**.
3. Paste the redirect URI from step 1 under **Authorised redirect URIs**. It
   must match character for character, including scheme and port.
4. Under **Audience**, add your own Google account as a **test user** — see
   *Publishing status* below.

### 3. Finish the plugin configuration

Paste the client ID and secret, then continue to the **Connect** step and press
**Connect Google account**.

Two other settings on the first step:

- **Read only** requests the `calendar.readonly` scope instead of `calendar`.
  Provider tables and actions can then read events but not change them.
- **Notify attendees by default** controls whether Google emails attendees
  about writes made through a provider table. The actions ask per action.

### Publishing status

A Google Cloud project with an **external** user type and a publishing status
of **Testing** issues refresh tokens that expire after **7 days**. This plugin
stores one long-lived refresh token, so a Testing-mode connection stops working
after a week and every provider table starts erroring until you reconnect.

| Your account | Do this | Result |
| --- | --- | --- |
| Google Workspace | Set the user type to **Internal** | No 7-day expiry, no verification needed |
| Personal Gmail | **Publish app** (In production) | Long-lived tokens; you click through an "unverified app" warning |
| Either, short term | Stay in **Testing** | Works, but reconnect weekly |

Verification is only needed to remove the warning screen and to go beyond 100
users. It is not needed to use this for yourself.

## Troubleshooting

**`Error 400: redirect_uri_mismatch`** — the URI registered in Google Cloud is
not byte-identical to the one the plugin sends. Copy it from the plugin
configuration page rather than typing it. `http://localhost` and
`http://127.0.0.1` are different URIs to Google.

**`Error 403: access_denied`, "can only be accessed by developer-approved
testers"** — the consent screen is in Testing and your account is not on the
test-user list. Add it under **Audience → Test users**.

**A 403 naming the Calendar API** — the API is not enabled for the project.

**`Bad Request (HTTP 400)` on a write** — Google rejected the event body. The
error now quotes the offending property. Most often it is an all-day event
whose end does not fall after its start, or a constrained property
(`status`, `transparency`, `visibility`, `color_id`) set to something other
than one of its permitted values.

**Everything stops working after about a week** — the 7-day refresh token
expiry above.

## Creating a table

Create a table with **Google Calendar** as the provider, then choose:

- **Events** — one calendar's events. Pick the calendar, whether to expand
  recurring events into occurrences, a default time window and a page cap.
- **Calendars** — the calendars the connected account can see. Read only.

### Event columns

`id`, `calendar_id`, `summary`, `description`, `location`, `start`, `end`,
`all_day`, `status`, `organizer_email`, `creator_email`, `attendees`,
`attendee_count`, `recurring_event_id`, `recurrence`, `transparency`,
`visibility`, `color_id`, `meet_link`, `html_link`, `ical_uid`, `created`,
`updated`.

`id` is the Google event id and the table's primary key, so
`sync_table_from_external` can match rows across runs.

`attendees` is a comma-separated list of email addresses. Writing to it
replaces the attendee list.

For all-day events, `end` is **exclusive**, exactly as the Google API reports
it: a one-day event on 25 December has `end` of 26 December. This is also what
FullCalendar expects. Shifting it would make the row disagree with the same
event read through any other client.

## What gets pushed down

The provider does its own filtering, ordering and paging. Conditions that map
onto the API are sent to Google, and everything is re-checked locally, so a
filter the API cannot express still returns the right rows — it just costs
more requests.

| Filter | Sent to Google as |
| --- | --- |
| `id` equals a string | a direct `events.get` — one request |
| `start`/`end` lower bound | `timeMin` |
| `start`/`end` upper bound | `timeMax` |
| `updated` lower bound | `updatedMin` |
| `ical_uid` equals | `iCalUID` |
| full-text search | `q` |
| `status` includes `cancelled` | `showDeleted` |

Everything else — `ilike`, `in`, `or`, `not`, numeric comparisons on
`attendee_count`, and so on — is evaluated locally over the fetched window.
`inSelect` and the other SQL-only operators raise an error naming the operator
rather than silently returning no rows.

Sorting by `start` ascending uses the API's own order, which lets a paged view
stop fetching as soon as it has enough rows. Any other sort has to read the
whole window first.

### The default window

A query carrying no date filter is bounded to the configured window — 365 days
either side of now by default. Without it, the first render of an unfiltered
list view walks every event since the account was created. Set it to 0 to
fetch everything, and raise the page cap to match.

Note that a paged view costs two walks of the window, because the Calendar API
has no count endpoint and `countRows` has to fetch the matching rows.

## Writing

Insert, update and delete work on an Events table when the plugin is not
connected read-only.

Updates are sent as `PATCH`, so a row carrying one changed column moves that
column and leaves the rest alone.

`deleteRows` refuses an empty filter. Deleting every event on a real calendar
cannot be undone from Saltcorn, so it has to be asked for explicitly.

## Actions

| Action | Use |
| --- | --- |
| `google_calendar_create_event` | Create an event from a row expression |
| `google_calendar_update_event` | Patch an event by id |
| `google_calendar_delete_event` | Delete an event by id |
| `google_calendar_find_events` | Read events into a workflow variable |
| `google_calendar_free_busy` | Busy periods across several calendars |

The event expression returns the same shape the provider's rows use, so a row
read from a Google Calendar table can be written straight back out:

```js
{summary: title, start: starts_at, end: ends_at, attendees: contact_email}
```

In a workflow, `find_events` and `free_busy` take a result variable and fill
it with an array — busy periods as `{calendar_id, start, end}`.

## Syncing into a local table

A provider table reads live, which means no joins to local tables, no history
and a request per view render. To keep a local copy, use the built-in
`sync_table_from_external` action with the Google Calendar table as the source
and `id` as the matching field. Run it on a schedule.

Use the provider table directly for calendars people are looking at now, and a
synced copy for anything that needs to be joined, reported on or kept.

## Token scope

Tokens are stored in the plugin configuration, so one connected Google account
serves the whole instance — the same model core uses for SMTP OAuth. Actions
therefore act as that account, not as the logged-in user. Per-user connections
would need a token table keyed by user id; `lib/oauth.js` is the only module
that would change.

Access tokens refresh automatically. Concurrent requests share one refresh, so
a page rendering several views does not fire several refresh grants at once.

## Development

```
npm test
```

73 tests covering the where-to-query translation, the local filter and sort,
the row mapping, paging and early stop, the retry and token-refresh behaviour,
and the configuration pages. Nothing touches the network: `fetch` is injected, and the token
source is substituted.

The saltcorn packages are resolved through symlinks in `node_modules`:

```
ln -sfn /path/to/saltcorn/packages/saltcorn-data   node_modules/@saltcorn/data
ln -sfn /path/to/saltcorn/packages/saltcorn-markup node_modules/@saltcorn/markup
```

### Layout

| File | Holds |
| --- | --- |
| `index.js` | plugin registration and the configuration workflow |
| `lib/config.js` | endpoints, scopes, live-config lookup |
| `lib/oauth.js` | the consent flow, token refresh and persistence |
| `lib/api.js` | authenticated fetch, retries, paging |
| `lib/query.js` | where → query parameters, local filter and sort |
| `lib/fields.js` | column definitions and row mapping |
| `lib/provider.js` | the table provider |
| `lib/actions.js` | the five actions |
| `lib/routes.js` | the OAuth redirect and callback routes |

`lib/config.js` holds `CALLBACK_PATH`, the single place the callback path is
spelled. The route and the setup instructions both derive from it, and a test
asserts they agree — a mismatch between them *is* `redirect_uri_mismatch`.

`lib/oauth.js`, `lib/api.js` and the pushdown approach in `lib/query.js` are
written to be lifted into a shared integrations package once a second Google
or REST integration needs them.

## Licence

MIT
