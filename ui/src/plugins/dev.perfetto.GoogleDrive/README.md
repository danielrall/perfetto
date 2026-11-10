# dev.perfetto.GoogleDrive

Opens traces from Google Drive, either through the "Open from GDrive" sidebar
button (file picker) or through Drive's "Open with" deep link
(`?state=<json>`), and uploads the current trace to Google Drive through the
"Share to GDrive" sidebar button.

## Flows

### Sidebar flow (openFileFromSidebar)

```mermaid
graph TD
    A[Click Open from GDrive] --> B{Flow already running}
    B -->|Yes| C[Do nothing]
    B -->|No| D[Authenticate]
    D --> E{Got token}
    E -->|No| F[Alert connect failed]
    E -->|Yes| G[Show file picker]
    G --> H{Picker result}
    H -->|Cancelled| I[Do nothing]
    H -->|Error| J[Alert picker failed]
    H -->|Picked| K[Download file]
    K --> L{Download ok}
    L -->|No| M[Alert download failed]
    L -->|Yes| N[Open trace]
```

### Deep link flow (openFileFromDeeplink)

```mermaid
graph TD
    A[Page loads with state param] --> B[Wait for clients to load]
    B --> C{Clients loaded}
    C -->|No| D[Alert Google Drive unavailable]
    C -->|Yes| E[Parse state param]
    E --> F{Valid}
    F -->|No| G[Do nothing]
    F -->|Yes| H[Authenticate]
    H --> I{Popup blocked}
    I -->|Yes| J[Prompt Connect to Google Drive]
    J --> K{User pressed Connect}
    K -->|No| L[Do nothing]
    K -->|Yes| M[Authenticate again]
    I -->|No| N{Got token}
    M --> N
    N -->|No| O[Alert connect failed]
    N -->|Yes| P[Remove state param from URL]
    P --> Q[Fetch metadata and download file in parallel]
    Q --> R{Access denied}
    R -->|Yes| S[Prompt Authorize access to file]
    S --> T{User pressed Authorize}
    T -->|No| U[Do nothing]
    T -->|Yes| V[Show picker for this file]
    V --> W{Picker result}
    W -->|Cancelled| X[Do nothing]
    W -->|Error| Y[Alert picker failed]
    W -->|Picked| Z[Download file again]
    R -->|No| AA{Download ok}
    Z --> AA
    AA -->|No| AB[Alert download failed]
    AA -->|Yes| AC[Open trace]
```

A share link from "Copy link" (`openFileId`) goes through the same flow. Its
file ID is checked instead of parsing `state`, an invalid one is ignored
before waiting for the clients, and it has no `state` param to remove.

### Upload flow (uploadTraceToGDrive)

The buttons of the "Share to Google Drive" dialog each start a flow like this
one. Failures are not shown in a dialog of their own, which would replace the
share dialog: they are recorded in the trace's share state and shown in a
banner in the share dialog.

```mermaid
graph TD
    A[Click Upload] --> B[Record upload in progress]
    B --> C[Authenticate]
    C --> D{Got token}
    D -->|No| E[Record connect failed]
    D -->|Yes| F{Cancelled meanwhile}
    F -->|Yes| G[Do nothing]
    F -->|No| H[Read back the trace contents]
    H --> I{Contents available}
    I -->|No| J[Record trace unavailable]
    I -->|Yes| K[Upload with progress]
    K --> L{Upload result}
    L -->|Cancelled| M[Do nothing]
    L -->|Error| N[Record upload failed]
    L -->|Done| O[Record file ID as saved]
    E --> P[Clear upload in progress]
    G --> P
    J --> P
    M --> P
    N --> P
    O --> P
```

"Change" (pick a folder) and "Share" (Drive's sharing dialog) are the same
shape: authenticate, then show the Google picker or sharing dialog, recording
any failure in the banner.

### Authenticate step (GoogleOAuthClient authenticate)

Every "Authenticate" box above runs this. It never throws: every outcome is
returned as a Result.

```mermaid
graph TD
    A[Authenticate called] --> B{Cached token exists}
    B -->|Yes| C{Token expired}
    C -->|No| D[Return cached token]
    C -->|Yes| E{Token request already in flight}
    B -->|No| E
    E -->|Yes| F[Wait for that request and share its result]
    E -->|No| G[Ask Google for a token via popup]
    G --> H{Google response}
    H -->|Token| I[Store token with expiry of expires_in minus 60 seconds]
    I --> J[Return new token]
    H -->|Popup failed to open| K[Return error popup_blocked]
    H -->|Popup closed| L[Return error popup_closed]
    H -->|Other error| M[Return error with cause]
```

## Manual testing

There are no automated tests for the Google connection and Drive flows, so
they need checking by hand. Keep this list up to date when adding a flow or a
failure mode.

### Checklist

Happy paths:

- [ ] [Sidebar flow](#sidebar-flow)
- [ ] [Token reuse within a session](#token-reuse-within-a-session)
- [ ] ["Open with" deep link](#open-with-deep-link)
- [ ] [Resource key](#resource-key)
- [ ] [Drive traces are not shareable](#drive-traces-are-not-shareable)

Sharing:

- [ ] [Upload the current trace](#upload-the-current-trace)
- [ ] [Cancel an upload](#cancel-an-upload)
- [ ] [Sidebar button state](#sidebar-button-state)
- [ ] [Close the dialog while uploading](#close-the-dialog-while-uploading)
- [ ] [Close the trace while uploading](#close-the-trace-while-uploading)
- [ ] [Choose a folder](#choose-a-folder)
- [ ] [After uploading](#after-uploading)
- [ ] [Share link](#share-link)
- [ ] [Sharing failures](#sharing-failures)

Button visibility:

- [ ] [Internal user](#button-visibility)
- [ ] [Non-internal user](#button-visibility)
- [ ] [Non-internal user with the external users flag](#button-visibility)
- [ ] [Initialisation fails](#initialisation-fails)
- [ ] [Plugin disabled](#plugin-disabled)

Failure modes:

- [ ] [Popup blocked](#popup-blocked-connect-to-google-drive-dialog)
- [ ] [Connection failure](#connection-failure-couldnt-connect-to-google-drive-dialog)
- [ ] [Google popup closed](#google-popup-closed)
- [ ] [File not yet authorised](#file-not-yet-authorised-authorize-access-to-file-dialog)
- [ ] [Initialisation fails, with a deep link](#initialisation-fails)
- [ ] [Invalid deep link payload](#invalid-deep-link-payload)
- [ ] [Download failures](#download-failures)
- [ ] [Picker failures](#picker-failures)

### Setup

1. Run `ui/run-dev-server` and open `http://localhost:10000`.
2. The plugin is not enabled by default. Open
   `http://localhost:10000/#!/plugins`, enable `dev.perfetto.GoogleDrive` and
   reload.
3. `http://localhost:10000` must be an authorised JavaScript origin on the
   OAuth client named in the config. If the picker works locally, it is.
4. The sidebar button is only shown to internal users, see
   [Button visibility](#button-visibility).
5. The access token is only kept in memory, so every page load starts
   disconnected.
6. Everything Google Drive support needs is loaded once, on every page load:
   the config and Google's scripts. See
   [Initialisation fails](#initialisation-fails).

Every "I give up" dialog (connection, picker and download failures) has an
"OK" button only, and no retry. Where there is an underlying error, it is
shown in a collapsed "Error details" section of the dialog rather than logged
to the console.

Two DevTools techniques are used below:

- **Block a request:** in the Network tab, right-click a request and choose
  "Block request URL" (or add a pattern in the "Network request blocking"
  drawer tab), then reload.
- **Build a deep link:** see ["Open with" deep link](#open-with-deep-link).

### Sidebar flow

1. Click "Open from GDrive" in the sidebar.
2. Complete the Google popup if it asks.
3. Pick a trace in the picker. It should open, titled with the file's name.
4. Cancel the picker instead of picking: nothing should happen.
5. Clicking the button again while a flow is still running (e.g. while the
   picker is open) should do nothing.

### Token reuse within a session

1. Complete the sidebar flow once.
2. Without reloading, click "Open from GDrive" again.
3. The picker should open straight away, with no Google popup.

The token is reused until about a minute before it expires (normally an hour).
After that, or after a page reload, the Google popup is needed again.

### "Open with" deep link

Drive opens the UI with a `state` query parameter naming the file. To
reproduce that without going through Drive, paste a URL like this into the
address bar of a new tab:

```
http://localhost:10000/?state=%7B%22ids%22%3A%5B%22<FILE_ID>%22%5D%2C%22action%22%3A%22open%22%7D
```

That is `{"ids":["<FILE_ID>"],"action":"open"}` URL-encoded. Take `<FILE_ID>`
from a Drive link (`https://drive.google.com/file/d/<FILE_ID>/view`).

Expected:

1. Unless popups are allowed for the site, the "Connect to Google Drive"
   dialog appears first, see
   [Popup blocked](#popup-blocked-connect-to-google-drive-dialog).
2. Once connected, the trace loads, titled with the file's real name. The
   deep link only carries the file ID, so the name is looked up from Drive
   with a separate metadata request, in parallel with the download.
3. The `state` parameter is removed from the address bar once connected. It
   stays if the user cancels the "Connect to Google Drive" dialog or
   connecting fails, so reloading retries the deep link.

The deep link is not restricted to internal users.

If the name lookup fails the trace should still open, titled "Google Drive
file", and a warning is logged to the console. To check, block
`*fields=name*` in DevTools and load the deep link again.

#### From a real "Open with" click

The app is registered with Google Drive as an "Open with" app, so the real
flow can be tested too:

1. Connect through the UI at least once (e.g. with the sidebar flow).
   Granting access is what adds Perfetto to your Drive's "Open with" menu.
2. In Drive, right-click a trace, choose "Open with" and pick Perfetto. Drive
   opens the registered URL with a `state` parameter for that file.
3. To land on a local build instead of the registered URL, use a redirect
   extension (e.g. Requestly) to rewrite the registered URL to
   `http://localhost:10000/`, keeping the query string.

A file opened this way should already be authorised, so it should load without
the "Authorize access to file" dialog.

### Resource key

Some link-shared files need a resource key as well as the file ID. Their links
look like `.../file/d/<FILE_ID>/view?resourcekey=<KEY>`. To test one, use a
file you do not own and have not opened before, and add the key to the state
payload:

```json
{"ids":["<FILE_ID>"],"action":"open","resourceKeys":{"<FILE_ID>":"<KEY>"}}
```

URL-encode it and load it as the `state` parameter. In the DevTools Network
tab, the Drive download and metadata requests should carry the header
`X-Goog-Drive-Resource-Keys: <FILE_ID>/<KEY>`.

### Drive traces are not shareable

Drive traces are access-controlled, so they must not be uploaded to the public
permalink bucket.

1. Open a trace from Drive by either route.
2. The UI should not offer to create a permalink for it. (The "Share to
   GDrive" button is separate: for a trace opened from Drive it shows "Saved
   to GDrive", see [After uploading](#after-uploading).)

### Button visibility

The "Open from GDrive" button is shown only when both of these hold:

- the user is internal, meaning the UI could fetch the manifest from the
  internal extension server (this needs a corp login), or the "Enable Google
  Drive integration for external users" flag is on, and
- initialisation succeeded: the config and Google's scripts all loaded.

Both are resolved shortly after startup, so the button can appear a moment
after the page loads.

To test:

1. **Internal user:** with a corp login, load the UI. The button should appear
   just below "Open trace file".
2. **Non-internal user:** block requests to
   `perfetto-gae-internal.googleplex.com` and reload. The button should not
   appear. The result of this check is cached in `localStorage.isInternalUser`
   and refreshed on every load.
3. **Non-internal user with the flag:** still as a non-internal user, open the
   flags page (`#!/flags`), enable "Enable Google Drive integration for
   external users" and reload. The button should now appear, and the sidebar
   flow should work with a non-corp Google account. The flag is listed on
   every deployment, not just localhost. Turn it off afterwards.

### Initialisation fails

On every page load the plugin loads, in order:

1. the config (API key, client ID and app ID), from
   `https://storage.googleapis.com/perfetto-misc/gdrive_config.json`,
2. Google's sign-in library, from `https://accounts.google.com/gsi/client`,
3. Google's API loader script, from `https://apis.google.com/js/api.js`,
4. the picker and sharing dialog modules, also from `apis.google.com`.

None of this opens a popup. If any step fails, "Failed to initialize Google
Drive" is logged to the console (with the failing step as its cause) and
nothing else is shown: no error dialog, as this runs for every user on every
load.

For each of the URLs above in turn:

1. Block it and reload.
2. The "Open from GDrive" button should not appear, even for an internal user.
   The console should show "Failed to initialize Google Drive".
3. Load a deep link URL with the request still blocked. A "Google Drive
   unavailable" dialog should appear, and the `state` parameter should stay in
   the address bar.
4. Unblock the URL and reload the same deep link. It should now proceed.

Also check that with everything blocked the rest of the UI works normally,
e.g. opening a local trace.

The config fetch times out after 5 seconds, and each of the other steps after
30 seconds. Until initialisation finishes, a deep link shows nothing. A failed
initialisation is not retried until the page is reloaded.

### Plugin disabled

The plugin is not enabled by default, so this is the state on a fresh profile.

1. Open `http://localhost:10000/#!/plugins`, make sure
   `dev.perfetto.GoogleDrive` is disabled, then reload.
2. The "Open from GDrive" button should not appear.
3. In the DevTools Network tab there should be no requests for the config or
   for Google's scripts (see [Initialisation fails](#initialisation-fails) for
   the URLs).
4. Loading a deep link URL should do nothing.
5. Re-enable the plugin afterwards.

### Popup blocked ("Connect to Google Drive" dialog)

This only happens on a deep link: the sidebar flow starts from a click, so the
browser allows the popup.

1. Make sure popups are not set to "Allow" for `localhost:10000`
   (`chrome://settings/content/popups`).
2. Load the deep link URL and do not click anything while it loads.
3. The "Connect to Google Drive" dialog should appear, including a hint that
   allowing pop-ups for the site skips this step.
4. Click "Connect". The Google popup should open, and once it completes the
   trace should load without a page reload.
5. Repeat and click "Cancel" instead. The dialog should close and nothing else
   should happen.
6. Set popups to "Allow" for `localhost:10000` and load the deep link again.
   The dialog should not appear; the Google popup should open by itself.

After "Connect" the popup is opened shortly after the click rather than inside
it, which Chrome allows. Other browsers may block it again, in which case the
"Couldn't connect to Google Drive" dialog appears saying the popup was
blocked.

### Connection failure ("Couldn't connect to Google Drive" dialog)

This is shown when Google reports an error while connecting, for example
because the user refuses to grant access.

1. Use a Google account that has not yet granted Perfetto access to Drive (or
   remove Perfetto's access from the account's third-party access page first).
2. Click "Open from GDrive", or load the deep link URL.
3. On Google's consent screen, press "Cancel" rather than granting access.
4. The "Couldn't connect to Google Drive" dialog should appear with Google's
   error, and the same error under "Error details", rather than the generic
   crash dialog.
5. "OK" dismisses it and ends the flow. Start again from the sidebar button or
   by reloading the deep link.

### Google popup closed

1. Set popups to "Allow" for `localhost:10000`, or start from the sidebar
   button.
2. When the Google popup opens, close it without completing it.
3. The "Couldn't connect to Google Drive" dialog should appear, saying the
   window was closed. There is no "Error details" section for this case.
4. "OK" dismisses it and ends the flow. Clicking the sidebar button again
   should reopen the popup; reloading a deep link should retry it.

### File not yet authorised ("Authorize access to file" dialog)

The app can only read files the user has opened or picked with it.

1. Set popups to "Allow" for `localhost:10000`.
2. Load the deep link URL with the ID of a file that has never been opened or
   picked through this app.
3. The download should fail with HTTP 403 or 404 and the "Authorize access to
   file" dialog should appear.
4. Click "Authorize File Access". The dialog closes and the picker opens,
   showing only that file. Pick it, and the trace should open, titled with the
   file's real name.
5. Repeat and click "Cancel" in the dialog, or cancel the picker: the flow
   should end silently.

Drive reports a file the app has not been granted as "not found", the same as
a file that does not exist. So a deep link with a made-up file ID also shows
this dialog; the picker it opens will then have nothing to pick.

### Invalid deep link payload

Each of these should be ignored silently: no dialog, no Google popup, and the
`state` parameter left in the address bar.

- `?state=not-json`
- `?state=%7B%22ids%22%3A%22abc%22%7D` (`ids` is not an array)
- `?state=%7B%22ids%22%3A%5B%5D%7D` (no file ID)
- A file ID or resource key containing anything other than letters, digits,
  `_` and `-`, e.g. `{"ids":["../x"]}`.

This assumes initialisation succeeded. The payload is only parsed after the
clients have loaded, so if initialisation fails any `state` parameter, valid
or not, shows the "Google Drive unavailable" dialog.

### Download failures

The easiest way to make only the download fail is to block
`*googleapis.com/drive/v3/files/*alt=media*` in DevTools: connecting, the
picker and the name lookup still work.

A failed download shows a "Couldn't open <file name> from Google Drive" dialog
(or "Couldn't open file from Google Drive" if the name is not known), with the
underlying error under "Error details".

The one exception is when Drive refuses access to the file (HTTP 403 or 404)
on a deep link: that shows the "Authorize access to file" dialog instead, see
[File not yet authorised](#file-not-yet-authorised-authorize-access-to-file-dialog).
On the sidebar flow a 403 or 404 is just a failed download.

- **Sidebar flow** (block the pattern, then pick a file): the failure dialog
  should appear.
- **Deep link, for an already authorised file** (block the pattern, then load
  the deep link): the failure dialog should appear, titled with the file's
  name, not the "Authorize access to file" dialog.
- **Deep link, the download after authorising fails** (load a deep link for a
  file not yet authorised, click "Authorize File Access", and block the
  pattern while the picker is showing, before picking the file): the failure
  dialog should appear.

### Picker failures

Cancelling or closing the picker is not a failure: from the sidebar nothing
happens, and on a deep link the flow ends silently.

If the picker cannot be built or reports an error, a "Couldn't open the Google
Drive file picker" dialog should appear, with the error under "Error details".

The picker's code is loaded during initialisation, so blocking requests
afterwards does not trigger this. To simulate it, run this in the DevTools
console after the page has loaded, then click "Open from GDrive":

```js
google.picker.PickerBuilder = class {
  constructor() {
    throw new Error('Simulated picker failure');
  }
};
```

### Upload the current trace

The "Share to GDrive" button is in the sidebar's current trace section. It
follows the same rules as "Open from GDrive", see
[Button visibility](#button-visibility). It is also hidden for traces whose
contents cannot be read back to upload, such as one loaded from
`trace_processor_shell --httpd`.

1. Open a trace from a local file.
2. Click "Share to GDrive". The "Share to Google Drive" dialog should open
   with the file name filled in and focused, and "My Drive" as the location.
3. Clear the file name: "Upload" should be disabled and the field outlined in
   red. Type a name again.
4. Click "Upload" (or press Enter). Complete the Google popup if it asks.
   While it uploads, the button should show a spinner and the text beside the
   buttons should count up, e.g. "Uploading… 42% (12.3 of 29.4 MB)". Use a
   large trace or DevTools Network throttling to make this last long enough
   to see.
5. The dialog should switch to "Saved to Google Drive", and the file should
   appear in Drive under that name.
6. Repeat with a large trace (hundreds of MB). The upload is sent as a single
   request rather than with Drive's resumable upload; this has been seen to
   work with a 600 MB trace.

### Cancel an upload

1. Start an upload that takes a while (large trace or DevTools Network
   throttling).
2. Click "Cancel", which only appears while uploading. The upload should
   stop, the form should return to normal with no error banner, and no file
   should appear in Drive.
3. Click "Upload" again: it should start a fresh upload.
4. Click "Upload" and then "Cancel" while the Google popup is still open,
   then complete the popup: nothing should be uploaded.

### Sidebar button state

The "Share to GDrive" button reflects what is happening, so an upload can be
followed with the dialog closed. Clicking it always opens the dialog.

| State | Text | Icon | Badge |
|---|---|---|---|
| Not uploaded | Share to GDrive | `add_to_drive` | preview |
| Uploading | Share to GDrive | `add_to_drive` | `…`, then a percentage |
| In Drive | Saved to GDrive | `cloud_done` | preview |
| Last action in the dialog failed | Share to GDrive | `error` | preview |

1. Start an upload that takes a while and close the dialog. The badge should
   count up.
2. When it finishes, the button should change to "Saved to GDrive" with the
   `cloud_done` icon.
3. Make an upload fail (see [Sharing failures](#sharing-failures)). The icon
   should change to `error`, and back once an upload succeeds.
4. Open a trace from Drive: the button should show "Saved to GDrive" from the
   start.

### Close the dialog while uploading

The dialog's state is kept with the trace, not with the dialog, so closing it
does not stop or hide an upload.

1. Start an upload that takes a while, then close the dialog (Escape, or its
   close button).
2. Reopen it with "Share to GDrive" while the upload is still running. It
   should show the upload in progress, with the count still moving, the name
   and location fields disabled, and "Cancel" working. It should not offer a
   second "Upload".
3. Close it again and wait for the upload to finish, then reopen it: it should
   show "Saved to Google Drive".
4. Repeat, but make the upload fail while the dialog is closed (go offline in
   DevTools). Reopening it should show the red banner.
5. Type a different file name, close the dialog without uploading, and reopen
   it: the name you typed should still be there.

### Close the trace while uploading

1. Start an upload that takes a while, then open a different trace (or close
   the current one).
2. The upload should be cancelled: in the DevTools Network tab the upload
   request should show as cancelled, and no file should appear in Drive.
3. The newly opened trace should show as not uploaded, with no progress on its
   "Share to GDrive" button.

### Choose a folder

1. In the dialog, click "Change". Complete the Google popup if it asks. The
   Google folder picker should open, titled "Select folder".
2. Pick a folder: the location field should show its name, and the upload
   should go there.
3. Click "Change" again and cancel the picker: the location should not change,
   and no banner should appear.
4. Pick a folder inside a shared drive (under "Shared drives" in Drive, as
   opposed to "My Drive") and upload: the file should appear there. Opening a
   trace that lives in a shared drive should work too.

### After uploading

With the dialog showing "Saved to Google Drive":

1. "Copy link" should copy a Perfetto link and briefly show "Copied".
2. "Share" should open Google Drive's sharing dialog for the file.
3. "Open in Drive" should open the file in Drive in a new tab.
4. Close and reopen the dialog: it should still show the saved state.
5. Open a trace from Drive (sidebar or deep link), then click "Share to
   GDrive": it should show the saved state straight away, without uploading.

### Share link

"Copy link" produces a link of the form
`<origin>#!/?dev.perfetto.GoogleDrive:openFileId=<FILE_ID>`.

1. Paste it into a new tab. It should behave like the
   ["Open with" deep link](#open-with-deep-link): connect (with the "Connect
   to Google Drive" dialog first unless popups are allowed), then the trace
   loads with its real name.
2. Open it as a different Google account that the file has been shared with.
   The "Authorize access to file" dialog should appear, see
   [File not yet authorised](#file-not-yet-authorised-authorize-access-to-file-dialog).
3. With initialisation failing (see
   [Initialisation fails](#initialisation-fails)), it should show the "Google
   Drive unavailable" dialog.
4. With an `openFileId` containing anything other than letters, digits, `_`
   and `-`, it should be ignored silently.

### Sharing failures

Failures in the share dialog are shown in a red banner at the top of the
dialog, not in a separate dialog, so the file name and location are kept.
Where there is an underlying error it is under "Error details" in the banner.
The banner clears when the next action starts, and the user retries by
pressing the same button again.

- **Upload fails:** block `*upload/drive/v3/files*` in DevTools and click
  "Upload". The banner should say the trace could not be uploaded, and
  "Upload" should be usable again.
- **Drive rejects the upload:** e.g. a full Drive. The banner's error details
  should include Drive's explanation and the HTTP status. Not easy to
  provoke.
- **Connection fails:** click "Upload", "Change" or "Share" and press
  "Cancel" on Google's consent screen (with an account that has not granted
  access yet). The banner should say connecting to Google Drive failed.
- **Google popup closed:** click "Upload" and close the Google popup. The
  banner should say the window was closed. Clicking "Upload" again should
  reopen the popup.
- **Folder picker or sharing dialog fails:** not easy to provoke. The banner
  should say the folder picker or sharing dialog could not be opened.
