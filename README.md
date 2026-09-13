# go+

Search UI for **Go Hilton** Friends & Family / Team Member availability.

## What you get

- Web app (`web/`) with destination + date range + filters + results table + CSV export
- Same Hilton calendar GraphQL the extension already uses: `hotel_shopAvailOptions_shopCalendarPropAvail`
- Hotel discovery via Hilton autocomplete (same “Where to?” API) + city-scoped hotel summary
- Runs inside the extension so your signed-in Hilton cookies are used

## Install

1. `chrome://extensions` → Developer mode
2. **Load unpacked** → this folder
3. Sign into [Go Hilton](https://www.hilton.com/en/go-hilton/) in Chrome
4. Click the extension → **Open search**

## URL style

```
chrome-extension://<id>/web/index.html?destination=Barcelona&date=2026-09-27&to=2026-10-27&nights=1&max_rate=200&min_rooms=1&rate_type=fnf
```

## Notes

- Browse any Go Hilton page once while signed in so `guestId` can be captured from Hilton GraphQL.
- “Go rates only” keeps F&F / Team Member and drops honors-discount fallbacks.
- One calendar request covers roughly a month per hotel.
- **Flight + hotel** mode uses the [Seats.aero partner API](https://developers.seats.aero/reference/getting-started-p) (cached search). Paste your Pro API key in the search page footer. Default transfer-partner filter is Chase UR (programs available on Seats.aero).
