#!/usr/bin/env python3
"""Validate the cross-file invariants of the Edge Canon governance records."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MATURITY = {
    "artifact-generated": 1,
    "syntax-verified": 2,
    "deployed": 3,
    "conformance-passed": 4,
}
FIRST_CLASS = {
    "deislet",
    "cloudflare-workers-pages",
    "tencent-edgeone-makers",
}


class ValidationError(RuntimeError):
    pass


def load_json(relative: str) -> dict:
    path = ROOT / relative
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"{relative}: {error}") from error
    if not isinstance(value, dict):
        raise ValidationError(f"{relative}: top-level value must be an object")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def validate_contract(contract: dict) -> None:
    require(contract.get("schemaVersion") == 1, "contract schemaVersion must be 1")
    require(contract.get("capabilityModel") == "single-standard", "only one standard is allowed")
    require(contract.get("profiles") == [], "capability profiles are forbidden")

    status = contract.get("releaseStatus")
    normative = contract.get("normativeRelease")
    require(
        normative is (status == "standard"),
        "normativeRelease may be true only for a released standard and must be true then",
    )

    proposal = ROOT / contract["governance"]["proposal"]
    require(proposal.is_file(), f"governance proposal does not exist: {proposal.relative_to(ROOT)}")

    dimensions = contract.get("semanticDimensions", [])
    require(len(dimensions) == len(set(dimensions)), "semanticDimensions contains duplicates")
    require(len(dimensions) >= 8, "all required semantic dimensions must be explicit")

    families = contract.get("capabilityFamilies", [])
    family_ids = [family.get("id") for family in families]
    require(family_ids and len(family_ids) == len(set(family_ids)), "capability family IDs must be unique")
    for family in families:
        require(family.get("requirement") == "mandatory", f"{family.get('id')}: non-mandatory profile found")
        require(
            family.get("definitionStatus") in {"pending", "draft", "normative-complete"},
            f"{family.get('id')}: invalid definitionStatus",
        )

    implementations = contract.get("initialImplementations", [])
    implementation_ids = [implementation.get("id") for implementation in implementations]
    require(
        len(implementation_ids) == len(set(implementation_ids)),
        "initial implementation IDs must be unique",
    )
    first_class = {
        implementation["id"]
        for implementation in implementations
        if implementation.get("role") == "first-class"
    }
    require(first_class == FIRST_CLASS, f"first-class backends must be exactly {sorted(FIRST_CLASS)}")

    if status in {"release-candidate", "standard"}:
        incomplete = [
            family["id"]
            for family in families
            if family["definitionStatus"] != "normative-complete"
        ]
        require(not incomplete, f"release is blocked by incomplete capability definitions: {incomplete}")


def validate_registry(contract: dict, registry: dict) -> None:
    require(registry.get("schemaVersion") == 1, "registry schemaVersion must be 1")
    require(registry.get("standardId") == contract.get("contractId"), "registry standardId does not match contract")
    require(
        registry.get("standardReleaseStatus") == contract.get("releaseStatus"),
        "registry release status does not match contract",
    )
    require(
        registry.get("standardContract") == "standard/contract.json",
        "registry must point at the canonical contract path",
    )

    expected = {item["id"]: item["role"] for item in contract["initialImplementations"]}
    backends = registry.get("backends", [])
    backend_ids = [backend.get("id") for backend in backends]
    require(len(backend_ids) == len(set(backend_ids)), "registry backend IDs must be unique")
    require(set(backend_ids) == set(expected), "registry and contract backend sets differ")

    for backend in backends:
        backend_id = backend["id"]
        require(backend.get("role") == expected[backend_id], f"{backend_id}: role differs from contract")
        maturity = backend["evidence"].get("maturity")
        require(maturity in MATURITY, f"{backend_id}: invalid evidence maturity")
        certification = backend["certification"]
        compliant = certification.get("compliant")
        supported = certification.get("supported")

        if compliant:
            require(contract.get("releaseStatus") == "standard", f"{backend_id}: proposal cannot be compliant")
            require(maturity == "conformance-passed", f"{backend_id}: compliance requires conformance-passed")
            require(backend["evidence"].get("outcome") == "pass", f"{backend_id}: compliance requires passing evidence")
            require(certification.get("status") == "valid", f"{backend_id}: compliant certification must be valid")
            require(certification.get("validUntil") is not None, f"{backend_id}: compliant certification must expire")
            require(not certification.get("blockers"), f"{backend_id}: compliant certification cannot have blockers")
        else:
            require(certification.get("status") != "valid", f"{backend_id}: valid certification must be compliant")

        if supported:
            require(compliant, f"{backend_id}: supported requires compliant")
            require(backend.get("role") == "first-class", f"{backend_id}: experimental backend cannot be supported")


def main() -> int:
    try:
        contract = load_json("standard/contract.json")
        registry = load_json("conformance/registry.json")
        load_json("schemas/standard-contract.schema.json")
        load_json("schemas/conformance-registry.schema.json")
        validate_contract(contract)
        validate_registry(contract, registry)
    except (KeyError, TypeError, ValidationError) as error:
        print(f"governance validation failed: {error}", file=sys.stderr)
        return 1

    print(
        "governance validation passed: "
        f"{len(contract['capabilityFamilies'])} mandatory capability families, "
        f"{len(registry['backends'])} backend records, 0 capability profiles"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
