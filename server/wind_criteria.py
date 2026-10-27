"""Versioned pedestrian-wind comfort criteria and their data requirements."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


LAWSON_LDDC_SCREENING_V1 = {
    "id": "lawson_lddc_style_screening_v1",
    "name": "Lawson-LDDC-style activity screen",
    "version": "1.0.0",
    "status": "screening",
    "implemented": True,
    "exceedance_probability": 0.05,
    "wind_speed_basis": "Weibull-derived exceedance from hourly mean forcing; the current CFD comfort field uses steady mean velocities.",
    "averaging_period": "Hourly climatology for forcing; CFD reference flow is steady and has no transient averaging window.",
    "gust_treatment": "No gust-equivalent mean or annual-gust safety check. ERA5 gust fields do not currently alter these comfort classes.",
    "source": {
        "citation": "Conditions legacy screening parameter set; Lawson-LDDC-style label is descriptive, not a claim of formal standards compliance.",
        "url": None,
    },
    "categories": [
        {"code": 0, "key": "long_sitting", "label": "Long sitting", "activity": "Long-duration sitting", "max_speed_mps": 2.5},
        {"code": 1, "key": "short_sitting", "label": "Short sitting", "activity": "Short-duration sitting", "max_speed_mps": 4.0},
        {"code": 2, "key": "standing", "label": "Standing", "activity": "Standing", "max_speed_mps": 6.0},
        {"code": 3, "key": "strolling", "label": "Strolling", "activity": "Strolling", "max_speed_mps": 8.0},
        {"code": 4, "key": "business_walking", "label": "Business walking", "activity": "Business walking", "max_speed_mps": 10.0},
        {"code": 5, "key": "uncomfortable", "label": "Uncomfortable", "activity": "Above the highest activity threshold", "max_speed_mps": None},
    ],
}

DAVENPORT_1972_MEAN_V1 = {
    "id": "davenport_1972_mean_5pct_v1",
    "name": "Davenport 1972 · hourly mean",
    "version": "1.0.0",
    "status": "screening",
    "implemented": True,
    "exceedance_probability": 0.05,
    "wind_speed_basis": "Hourly mean wind-speed thresholds with a 5% exceedance probability; implemented with Weibull exceedance from directional ERA5 means.",
    "averaging_period": "Hourly mean wind speed; climatological hourly samples are frequency weighted across the selected season/year.",
    "gust_treatment": "No gust adjustment; this is the mean-speed form of the criterion. It does not provide a gust or pedestrian-safety assessment.",
    "source": {
        "citation": "A.G. Davenport (1972), An approach to human comfort criteria for environmental conditions, Colloquium on Building Climatology, Stockholm. Threshold bands reproduced in Windtech Consultants, Pedestrian Wind Environment Study, Appendix A, Table A.2 (2021).",
        "url": "https://docs.planning.org.uk/20210719/129/DCAPR_155865/nfidamevhegvfr1h.pdf",
        "location": "Appendix A, Table A.2, PDF pages 50–51",
    },
    "categories": [
        {"code": 0, "key": "long_exposure", "label": "Long exposure", "activity": "Long-duration stationary activities", "max_speed_mps": 3.5},
        {"code": 1, "key": "short_exposure", "label": "Short exposure", "activity": "Short-duration stationary activities", "max_speed_mps": 5.5},
        {"code": 2, "key": "strolling_skating", "label": "Strolling / skating", "activity": "Slow walking or skating", "max_speed_mps": 7.5},
        {"code": 3, "key": "fast_walking", "label": "Fast walking", "activity": "Fast walking and main public accessways", "max_speed_mps": 10.0},
        {"code": 4, "key": "uncomfortable", "label": "Above criterion", "activity": "Above the highest activity threshold", "max_speed_mps": None},
    ],
}

LAWSON_LDDC_2001_GEM_V1 = {
    "id": "lawson_lddc_2001_gem_v1",
    "name": "Lawson LDDC 2001 · gust-equivalent mean",
    "version": "1.0.0",
    "status": "not_available",
    "implemented": False,
    "exceedance_probability": 0.05,
    "wind_speed_basis": "Comfort thresholds apply to gust-equivalent mean (GEM): max(hourly mean speed, 3-second gust / 1.85). The reported implementation reference gives 4 m/s sitting, 6 m/s standing, and 8 m/s walking thresholds.",
    "averaging_period": "Hourly mean plus 3-second gust for comfort; annual maximum gust for safety.",
    "gust_treatment": "Requires a 3-second gust estimate for GEM and an annual-maximum gust distribution for the 15 m/s safety check. Neither is currently derived from the steady CFD fields.",
    "unavailable_reason": "No validated pedestrian-scale 3-second gust or annual-maximum gust model is available. This option is listed for provenance but cannot be selected or scored.",
    "source": {
        "citation": "T.V. Lawson (April 2001), original LDDC criteria, reproduced in Windtech Consultants, Pedestrian Wind Environment Study, Tables 3–4 (2021).",
        "url": "https://docs.planning.org.uk/20210719/129/DCAPR_155865/nfidamevhegvfr1h.pdf",
        "location": "Section 5.2, Tables 3–4, PDF page 21",
    },
    "categories": [
        {"code": 0, "key": "sitting", "label": "Sitting", "activity": "Long and short duration sitting", "max_speed_mps": 4.0},
        {"code": 1, "key": "standing", "label": "Standing", "activity": "Short-duration stationary activities", "max_speed_mps": 6.0},
        {"code": 2, "key": "walking", "label": "Walking", "activity": "External pavements and walkways", "max_speed_mps": 8.0},
        {"code": 3, "key": "uncomfortable", "label": "Uncomfortable", "activity": "Above the walking threshold", "max_speed_mps": None},
    ],
}

CRITERIA = {
    LAWSON_LDDC_SCREENING_V1["id"]: LAWSON_LDDC_SCREENING_V1,
    DAVENPORT_1972_MEAN_V1["id"]: DAVENPORT_1972_MEAN_V1,
    LAWSON_LDDC_2001_GEM_V1["id"]: LAWSON_LDDC_2001_GEM_V1,
}
DEFAULT_CRITERION_ID = LAWSON_LDDC_SCREENING_V1["id"]


def get_criterion(criterion_id: str | None = None) -> dict[str, Any]:
    identifier = criterion_id or DEFAULT_CRITERION_ID
    criterion = CRITERIA.get(identifier)
    if criterion is None or not criterion.get("implemented"):
        raise ValueError(f"unsupported wind comfort criterion: {identifier}")
    return criterion


def criterion_catalog() -> dict[str, Any]:
    return {
        "schema": "conditions-wind-criteria/1",
        "default_criterion_id": DEFAULT_CRITERION_ID,
        "criteria": [deepcopy(item) for item in CRITERIA.values()],
        "shared_method": {
            "probability_method": "Weibull exceedance from sector mean speed, frequency weighted by the ERA5 wind rose for Comfort mode.",
            "safety_status": "Neither available comfort option evaluates annual maximum gust safety.",
        },
    }
