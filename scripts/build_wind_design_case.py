#!/usr/bin/env python3
"""Export an edited building scene as an OpenFOAM wind design case.

Proposal JSON schema:
{
  "name": "New podium option",
  "direction_deg": 135,
  "remove_building_indexes": [14],
  "add_buildings": [[ground_m, height_m, [[x,z], ...]]]
}

Run without --solve to prepare and inspect the candidate geometry. --solve
meshes, runs OpenFOAM, converts the result for the browser, and registers it
in public/assets/cfd/design-cases.json for same-direction comparisons.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("proposal", type=Path, help="JSON proposal geometry operations")
    parser.add_argument("--slug", help="stable identifier used for generated case assets")
    parser.add_argument("--direction-deg", type=float, help="override proposal direction")
    parser.add_argument("--solve", action="store_true", help="mesh, run OpenFOAM, convert and register result")
    parser.add_argument("--base-cell-m", type=float, default=12)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    proposal = json.loads(args.proposal.read_text(encoding="utf-8"))
    raw_slug = args.slug or str(proposal.get("name", "proposal"))
    slug = re.sub(r"[^a-z0-9]+", "-", raw_slug.lower()).strip("-")[:48] or "proposal"
    direction = args.direction_deg if args.direction_deg is not None else float(proposal.get("direction_deg", 135))

    base_path = ROOT / "public/assets/fallback.json"
    scene = json.loads(base_path.read_text(encoding="utf-8"))
    original_count = len(scene.get("buildings", []))
    removals = set(proposal.get("remove_building_indexes", []))
    if any(not isinstance(index, int) or index < 0 or index >= original_count for index in removals):
        parser.error(f"building indexes must be in [0, {original_count - 1}]")
    scene["buildings"] = [record for index, record in enumerate(scene["buildings"]) if index not in removals]
    additions = proposal.get("add_buildings", [])
    for record in additions:
        if len(record) < 3 or len(record[2]) < 3 or float(record[1]) <= 0:
            parser.error("each added building needs [ground_m, positive_height_m, ring_of_at_least_3_xz_points]")
        scene["buildings"].append(record)

    proposal_dir = ROOT / "data/openfoam/proposals" / slug
    proposal_dir.mkdir(parents=True, exist_ok=True)
    scene_path = proposal_dir / "scene.json"
    scene_path.write_text(json.dumps(scene, separators=(",", ":")) + "\n", encoding="utf-8")
    metadata = {
        "name": proposal.get("name", slug), "slug": slug,
        "direction_deg": direction, "removed_buildings": len(removals),
        "added_buildings": len(additions), "source_buildings": original_count,
        "candidate_buildings": len(scene["buildings"]), "scene": str(scene_path.relative_to(ROOT)),
        "geometry_status": "proposal_geometry_unreviewed",
    }
    (proposal_dir / "proposal.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {scene_path}: {metadata['candidate_buildings']} buildings ({len(removals)} removed, {len(additions)} added)")
    if not args.solve:
        print("Review proposal.json and scene.json, then rerun with --solve to create CFD results.")
        return

    case_id = f"proposal_{slug}_{str(direction).replace('.', 'p')}"
    case_dir = ROOT / "data/openfoam/cases" / case_id
    asset_dir = ROOT / "public/assets/cfd" / case_id
    subprocess.run([
        sys.executable, str(ROOT / "scripts/export_openfoam_case.py"), "--scene", str(scene_path),
        "--output", str(case_dir), "--direction-deg", str(direction), "--full-scene",
        "--base-cell-m", str(args.base_cell_m),
    ], check=True, cwd=ROOT)
    (case_dir / "Allmesh").chmod(0o755)
    (case_dir / "Allrun").chmod(0o755)
    (case_dir / "Allpost").chmod(0o755)
    environment = {**__import__("os").environ, "OPENFOAM_NPROCS": str(max(1, args.workers))}
    for task in ("Allmesh", "Allrun", "Allpost"):
        subprocess.run(["bash", task], check=True, cwd=case_dir, env=environment)
    vtk_files = sorted((case_dir / "VTK").glob("*.vtk"), key=lambda path: path.stat().st_mtime)
    if not vtk_files:
        raise SystemExit("OpenFOAM completed without a VTK volume to convert")
    subprocess.run([
        sys.executable, str(ROOT / "scripts/convert_openfoam_vtk.py"), str(vtk_files[-1]),
        "--case", str(case_dir / "case.json"), "--output", str(asset_dir),
    ], check=True, cwd=ROOT)
    cases_path = ROOT / "public/assets/cfd/design-cases.json"
    cases = json.loads(cases_path.read_text(encoding="utf-8")) if cases_path.exists() else []
    item = {
        "case_id": case_id, "label": metadata["name"], "direction_deg": direction,
        "base": f"/assets/cfd/{case_id}/", "design_comparison": True,
    }
    cases = [existing for existing in cases if existing.get("case_id") != case_id]
    cases.append(item)
    cases_path.write_text(json.dumps(cases, indent=2) + "\n", encoding="utf-8")
    print(f"Registered solved design in {cases_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
