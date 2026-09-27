# @saltcorn/google-calendar

A Google Calendar table provider and action set for Saltcorn. Events and
calendars become ordinary Saltcorn tables you can build views on, and five
actions let triggers and workflows write back.

This is a data-layer module: it adds table providers and actions, and no UI of
its own. An events table renders in `@saltcorn/fullcalendar` without any
further configuration.

## Setup

### 1. Create an OAuth client in Google Cloud

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or
   create a project and enable the **Google Calendar API**.
2. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID**
   of type **Web application**.
3. Leave the redirect URI blank for now.

### 2. Configure the plugin

Install the module, then open its configuration page. Fill in the base URL,
client ID and client secret. The page shows the exact redirect URI to register:

```
https://your-saltcorn-host/google-calendar/oauth2/callback
```

Paste that into the OAuth client's **Authorised redirect URIs** in Google
Cloud. It must match character for character, including scheme and port.

Two other settings:

- **Read only** requests the `calendar.readonly` scope instead of `calendar`.
  Provider tables and actions can then read events but not change them.
- **Notify attendees by default** controls whether Google emails attendees
  about writes made through a provider table. The actions ask per action.

### 3. Connect the Google account

On the **Connect** step, press **Connect Google account**. You are sent to
Google's consent screen and back. One Google account serves the whole Saltcorn
instance — see *Token scope* below.

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

45 tests covering the where-to-query translation, the local filter and sort,
the row mapping, paging and early stop, and the retry and token-refresh
behaviour. Nothing touches the network: `fetch` is injected, and the token
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

`lib/oauth.js`, `lib/api.js` and the pushdown approach in `lib/query.js` are
written to be lifted into a shared integrations package once a second Google
or REST integration needs them.

## Licence

MIT
