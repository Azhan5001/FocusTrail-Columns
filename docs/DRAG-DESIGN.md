# External drag design and verification

## Decision

Use a separate GJS/GTK4 window as the real drag source. The extension sends a snapshot of local file URIs to it via a subprocess stdin pipe. The window creates a GtkDragSource with COPY actions and a GdkContentProvider union: typed GdkFileList plus explicit text/uri-list. GTK handles the desktop transfer. The user initiates the native drag with a new press in this window.

This implementation prioritizes a standard desktop transfer over a continuous Shell-row-to-app gesture. No clipboard ownership replacement, pointer simulation, compositor monkey-patching, or root service is involved.

## Research findings

- [Meta.Dnd API](https://mutter.gnome.org/meta/class.Dnd.html): the documented public object exposes incoming DND signals, with no public start-drag method. Assigning data to a selection is not by itself a complete external drag protocol.
- [Wayland data device protocol](https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_data_device-request-start_drag): start_drag requires an origin surface and a matching active implicit grab serial. A freshly launched helper did not receive the button press on a GNOME Shell row. Consequently, handing that original press to a GTK window is not a portable implementation strategy. A new press inside GTK supplies the correct source event.
- [GTK drag and drop](https://docs.gtk.org/gtk4/drag-and-drop.html) and [GtkDragSource](https://docs.gtk.org/gtk4/class.DragSource.html): a native widget controller supplies data through a content provider and emits begin/cancel/end signals. COPY avoids source deletion on completion.
- [GdkFileList](https://docs.gtk.org/gdk4/struct.FileList.html) and [new_from_array](https://docs.gtk.org/gdk4/ctor.FileList.new_from_array.html): represent multiple real GFiles. Using this type also lets GTK negotiate applicable native/portal formats; sandboxed receiver behavior remains environment-dependent.
- [ContentProvider.new_union](https://docs.gtk.org/gdk4/ctor.ContentProvider.new_union.html): combines representations; the explicit URI-list covers receivers requesting that MIME type. URI payloads use CRLF, and Gio produces correctly escaped file URIs. Plain-text formats are intentionally not offered.
- [GJS GValue guide](https://gjs.guide/guides/gobject/gvalue.html): explicit typed values can be passed to ContentProvider.new_for_value. The helper uses explicit FileList typing.

## Behavior and boundaries

- Ctrl+Shift+D and the context action use the same selection snapshot, taken before closing the menu clears selection.
- GtkApplication owns one session-bus application identity. Repeated launches forward their file lists to its primary process. The same selection is presented again; changed selections replace an idle window. An active drag is preserved.
- The helper only queries metadata before enabling the card. It does not read whole photos/videos into Shell memory.
- File names travel over stdin as JSON, never through an interpolated shell command. Local paths are converted to canonical file URIs. Duplicates are removed; malformed requests, remote-only URIs and oversized batches are rejected.
- Files must be local/readable; unresolved SFTP/phone URIs are not converted into fake local files. Copy those locally first. No implicit network downloads are performed.
- The helper closes after both drag-end and GdkDrag::dnd-finished, unless cancelled or Keep open is checked. The latter signal means the receiver has finished reading the transfer data. A drop is not a claim that a website has uploaded/sent a file.
- Disabling the extension terminates its helper. Closing the helper during an active drag is prevented until that drag ends or is cancelled.
- The source should work through GTK on Wayland and supported X11 sessions. That is a design expectation, not an observed test result for this build.

## Verification performed in the build environment

- JavaScript syntax checks for extension, preferences, bridge, payload and helper.
- Bash syntax check for installation scripts; metadata and schema XML parsing.
- Seven automated tests: URI escaping/deduplication; invalid/remote/oversized payload rejection; stdin-only launch and repeated launch forwarding; missing helper/remote path rejection; process failure/disposal; selection snapshot before menu closure and failed-launch preservation; offline drop-page acceptance of readable Files and rejection of text-only data (Node, not a graphical browser).
- Two real installer filesystem tests with mocked desktop executables: successful upgrade installs all required files and preserves the old copy; GTK preflight failure leaves the old installation untouched.

The user confirmed that v23 drag and drop works on their desktop. No GJS executable, GTK4 runtime, GNOME session, or installed graphical browser was available in this build environment for live testing of the v24 changes. Therefore live drag negotiation, rendering, portal behavior, and WhatsApp/Chrome/Firefox acceptance were **not** tested. The installer executes a real GTK provider construction check on the user's machine. The bundled offline browser test distinguishes actual readable File objects from a path/text drop.

## Manual end-to-end test

1. Install, log out/in, and confirm internal version 24.
2. Choose a small local PNG or TXT file; Ctrl+Shift+D; wait for Ready.
3. Open the local drop test from the helper; drag the card to the box. Confirm a real File object and PASS/readable result.
4. Repeat with two files, including a name containing spaces/non-ASCII characters.
5. Cancel a drag with Escape, then retry. Drop outside a target and retry. Close/reopen the helper.
6. Drop into the actual destination's attachment area. Confirm the app's attachment preview. Sending an attachment remains a separate user action.

## Version 24 lifecycle checks

Five additional tests execute the helper's real handlers with a mocked widget layer: completion signals in either order; rejection/cancellation stays open; Keep open overrides success; a repeated request presents an existing window and cancels pending close; changed selection replaces only an idle window. Twelve JavaScript tests and two installer tests pass. GTK window presentation and session-bus forwarding still require live desktop verification.

The Shell also explicitly activates the existing window only if its PID belongs to a helper it launched. This supports raising a window behind another app without relying solely on client focus requests.

References: [GdkDrag dnd-finished](https://docs.gtk.org/gdk4/signal.Drag.dnd-finished.html), [GApplication open](https://docs.gtk.org/gio/signal.Application.open.html).
