#!/usr/bin/env bash
# Run one generated case only when its standard mesh check passed.
set -euo pipefail

case_dir=${1:?usage: run_openfoam_safe.sh data/openfoam/cases/cbd_22p5_full}
if [[ ! -d "$case_dir" ]]; then
  echo "case does not exist: $case_dir" >&2
  exit 2
fi
if [[ ! -f "$case_dir/log.checkMesh.standard" ]] || ! grep -q 'Mesh OK' "$case_dir/log.checkMesh.standard"; then
  echo "refusing to solve: $case_dir has no passing standard checkMesh" >&2
  exit 2
fi

# Phi is a generated potential-flow field and is mesh-sized.  Rebuilding a
# mesh leaves an old Phi behind in some OpenFOAM cases; potentialFoam then
# fails with a field-size mismatch before the actual solver starts.
rm -f "$case_dir/0/Phi"
export OPENFOAM_NPROCS=1
(cd "$case_dir" && ./Allrun)
