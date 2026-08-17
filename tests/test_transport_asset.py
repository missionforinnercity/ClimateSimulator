from scripts.build_transport_asset import load_prasa_schedules, prasa_corridor


def test_prasa_corridor_mapping_uses_stopping_pattern():
    assert prasa_corridor("Northern Line", ["CAPE TOWN", "STRAND"]) == "strand"
    assert prasa_corridor("Northern Line", ["CAPE TOWN", "WELLINGTON"]) == "wellington"
    assert prasa_corridor("Central Line", ["CAPE TOWN", "KAPTEINSKLIP"]) == "mitchells-plain"
    assert prasa_corridor("Central Line", ["CAPE TOWN", "CHRIS HANI"]) == "khayelitsha"


def test_prasa_csv_produces_directional_service_calendars():
    schedules, effective_date = load_prasa_schedules()
    assert effective_date
    assert len(schedules) == 8
    assert schedules["southern"]["weekday"]["inboundArrivals"]
    assert schedules["southern"]["weekday"]["outboundDepartures"]
    assert schedules["cape-flats"]["saturday"]["inboundArrivals"]
    assert schedules["cape-flats"]["sunday"]["outboundDepartures"]
    for calendar in schedules.values():
        for service in calendar.values():
            assert service["inboundArrivals"] == sorted(set(service["inboundArrivals"]))
            assert service["outboundDepartures"] == sorted(set(service["outboundDepartures"]))
