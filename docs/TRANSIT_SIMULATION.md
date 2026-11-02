# Scheduled transit vehicles

MyCiTi buses and Metrorail trains continue to animate through the CBD scene as
background simulation. There is no transit tab, event-access planner, or
user-facing route control panel.

Vehicle positions come from the checked-in timetable asset. They are estimates,
not live GPS, confirmed arrival times, or service-status information. MyCiTi
movement uses supplied weekday timetable PDFs where available; weekend buses
are omitted because weekend tables are not supplied. Matched PRASA schedules
are used for rail, with estimated cadence on unmatched corridors.

Rebuild the compact asset with:

```bash
python scripts/build_transport_asset.py
```

The script reads source schedules and geometry under `data/transport/` and
writes `public/assets/transport.json`. The scene animation also uses the
checked-in railway geometry and does not need an operator account or live feed.
