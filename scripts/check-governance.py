#!/usr/bin/env python3
"""Validate the cross-file invariants of the Edge Canon governance records."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import jsonschema


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
REQUIRED_DIMENSIONS = (
    "api",
    "errors",
    "concurrency-consistency-ordering",
    "lifecycle",
    "minimum-resource-guarantees",
    "security-isolation",
    "failure-recovery",
    "upgrade-migration",
)
DEFINITION_STATUSES = {"pending", "draft", "normative-complete"}
CONFORMANCE_STATUSES = {"planned", "draft", "complete"}
CLAUSE_PATTERN = re.compile(r"^EC-[A-Z0-9-]+$")


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


def validate_schema_documents() -> None:
    documents = {
        "standard/contract.json": "schemas/standard-contract.schema.json",
        "standard/requirements.json": "schemas/requirements-registry.schema.json",
        "conformance/kit.json": "schemas/conformance-kit.schema.json",
        "conformance/cases/web-fetch-events.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/web-fetch-events/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/harness/web-fetch-events/sample-pass.json": "schemas/conformance-observations.schema.json",
        "conformance/registry.json": "schemas/conformance-registry.schema.json",
    }
    for relative, schema_relative in documents.items():
        schema = load_json(schema_relative)
        try:
            jsonschema.Draft202012Validator.check_schema(schema)
            jsonschema.Draft202012Validator(
                schema,
                format_checker=jsonschema.FormatChecker(),
            ).validate(load_json(relative))
        except jsonschema.SchemaError as error:
            raise ValidationError(f"{schema_relative}: invalid JSON Schema: {error.message}") from error
        except jsonschema.ValidationError as error:
            location = "/".join(str(part) for part in error.absolute_path) or "<root>"
            raise ValidationError(f"{relative}/{location}: {error.message}") from error


def validate_contract(contract: dict) -> None:
    require(contract.get("schemaVersion") == 1, "contract schemaVersion must be 1")
    require(contract.get("capabilityModel") == "single-standard", "only one standard is allowed")
    require(contract.get("profiles") == [], "capability profiles are forbidden")

    resource_guarantees = contract.get("resourceGuarantees", {})
    require(
        resource_guarantees.get("referencePlanBaseline")
        == "lowest-generally-available-free-or-entry-plan",
        "resource guarantees must use every reference vendor's lowest generally available free or entry plan",
    )
    require(
        resource_guarantees.get("allReferenceVendorsMustMeetBaseline") is True,
        "every reference vendor must meet the resource baseline",
    )
    require(
        resource_guarantees.get("unknownPublicGuarantee") == "release-blocker",
        "an unknown public resource guarantee must block release",
    )
    require(
        resource_guarantees.get("higherPlanCapacityIsPortable") is False,
        "higher-plan capacity must not become a portable application guarantee",
    )

    status = contract.get("releaseStatus")
    normative = contract.get("normativeRelease")
    require(
        normative is (status == "standard"),
        "normativeRelease may be true only for a released standard and must be true then",
    )

    proposal = ROOT / contract["governance"]["proposal"]
    require(proposal.is_file(), f"governance proposal does not exist: {proposal.relative_to(ROOT)}")

    dimensions = contract.get("semanticDimensions", [])
    require(
        dimensions == list(REQUIRED_DIMENSIONS),
        "semanticDimensions must be the canonical eight dimensions in order",
    )

    requirements_path = contract.get("requirementsRegistry")
    require(requirements_path == "standard/requirements.json", "contract must name the canonical requirements registry")
    require((ROOT / requirements_path).is_file(), "contract requirements registry does not exist")
    kit_path = contract.get("conformance", {}).get("kit")
    require(kit_path == "conformance/kit.json", "contract must name the canonical conformance kit")
    require((ROOT / kit_path).is_file(), "contract conformance kit does not exist")

    families = contract.get("capabilityFamilies", [])
    family_ids = [family.get("id") for family in families]
    require(family_ids and len(family_ids) == len(set(family_ids)), "capability family IDs must be unique")
    for family in families:
        require(family.get("requirement") == "mandatory", f"{family.get('id')}: non-mandatory profile found")
        require(
            family.get("definitionStatus") in DEFINITION_STATUSES,
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


def validate_requirements(contract: dict, requirements: dict) -> dict[str, str]:
    require(requirements.get("schemaVersion") == 1, "requirements schemaVersion must be 1")
    require(requirements.get("standardId") == contract.get("contractId"), "requirements standardId does not match contract")
    require(requirements.get("semanticDimensions") == list(REQUIRED_DIMENSIONS), "requirements dimensions differ from contract")
    expected_document_status = "frozen" if contract.get("releaseStatus") in {"release-candidate", "standard"} else "draft"
    require(requirements.get("status") == expected_document_status, "requirements document status differs from release stage")

    contract_families = {family["id"]: family for family in contract["capabilityFamilies"]}
    families = requirements.get("families", [])
    family_ids = [family.get("id") for family in families]
    require(len(family_ids) == len(set(family_ids)), "requirements family IDs must be unique")
    require(set(family_ids) == set(contract_families), "requirements and contract family sets differ")

    clause_owner: dict[str, str] = {}
    for family in families:
        family_id = family["id"]
        status = family.get("definitionStatus")
        require(status in DEFINITION_STATUSES, f"{family_id}: invalid requirements definitionStatus")
        require(status == contract_families[family_id]["definitionStatus"], f"{family_id}: definitionStatus differs from contract")

        dimensions = family.get("dimensions", {})
        require(set(dimensions) == set(REQUIRED_DIMENSIONS), f"{family_id}: dimensions must match the canonical set")
        dimension_statuses: list[str] = []
        family_clause_ids: list[str] = []
        for dimension_name in REQUIRED_DIMENSIONS:
            dimension = dimensions[dimension_name]
            dimension_status = dimension.get("status")
            clause_ids = dimension.get("clauseIds", [])
            require(dimension_status in DEFINITION_STATUSES, f"{family_id}/{dimension_name}: invalid status")
            require(len(clause_ids) == len(set(clause_ids)), f"{family_id}/{dimension_name}: duplicate clause ID")
            if dimension_status == "pending":
                require(not clause_ids, f"{family_id}/{dimension_name}: pending dimension has clauses")
            else:
                require(clause_ids, f"{family_id}/{dimension_name}: defined dimension has no clauses")
            for clause_id in clause_ids:
                require(bool(CLAUSE_PATTERN.fullmatch(clause_id)), f"{clause_id}: invalid clause ID")
                require(clause_id not in clause_owner, f"{clause_id}: clause ID is duplicated")
                clause_owner[clause_id] = family_id
            family_clause_ids.extend(clause_ids)
            dimension_statuses.append(dimension_status)

        draft_path = family.get("draftPath")
        evidence_paths = family.get("evidencePaths", [])
        require(len(evidence_paths) == len(set(evidence_paths)), f"{family_id}: duplicate evidence path")
        for evidence_path in evidence_paths:
            require((ROOT / evidence_path).is_file(), f"{family_id}: evidence path does not exist: {evidence_path}")
        if status == "pending":
            require(all(value == "pending" for value in dimension_statuses), f"{family_id}: pending family contains defined dimensions")
            require(draft_path is None, f"{family_id}: pending family must not claim a draft path")
        else:
            require(isinstance(draft_path, str) and draft_path, f"{family_id}: defined family needs a draft path")
            draft_file = ROOT / draft_path
            require(draft_file.is_file(), f"{family_id}: draft path does not exist: {draft_path}")
            draft_text = draft_file.read_text(encoding="utf-8")
            for clause_id in family_clause_ids:
                require(draft_text.count(clause_id) == 1, f"{clause_id}: clause must appear exactly once in {draft_path}")
        if status == "normative-complete":
            require(
                all(value == "normative-complete" for value in dimension_statuses),
                f"{family_id}: normative-complete requires all dimensions complete",
            )
        if status == "draft":
            require(any(value == "draft" for value in dimension_statuses), f"{family_id}: draft family has no draft dimension")

        conformance = family.get("conformance", {})
        for key in ("fixtureStatus", "oracleStatus", "harnessStatus"):
            require(conformance.get(key) in CONFORMANCE_STATUSES, f"{family_id}: invalid {key}")
        if status == "normative-complete":
            require(
                all(conformance.get(key) == "complete" for key in ("fixtureStatus", "oracleStatus", "harnessStatus")),
                f"{family_id}: normative-complete requires complete fixture, oracle, and harness",
            )

    return clause_owner


def validate_cases(relative_path: str, standard_id: str, suite_id: str, clause_owner: dict[str, str], family_id: str) -> set[str]:
    case_file = load_json(relative_path)
    require(case_file.get("schemaVersion") == 1, f"{relative_path}: schemaVersion must be 1")
    require(case_file.get("standardId") == standard_id, f"{relative_path}: standardId mismatch")
    require(case_file.get("suiteId") == suite_id, f"{relative_path}: suiteId mismatch")
    require(case_file.get("status") in {"draft", "frozen"}, f"{relative_path}: invalid case document status")
    require(case_file.get("executionModel") == "provider-independent-oracle", f"{relative_path}: invalid execution model")
    cases = case_file.get("cases", [])
    case_ids = [case.get("id") for case in cases]
    require(cases and len(case_ids) == len(set(case_ids)), f"{relative_path}: case IDs must be present and unique")
    covered: set[str] = set()
    for case in cases:
        clause_ids = case.get("clauseIds", [])
        require(clause_ids, f"{relative_path}/{case.get('id')}: no clause IDs")
        require(case.get("fixture", {}).get("requirements"), f"{relative_path}/{case.get('id')}: fixture requirements missing")
        require(case.get("oracle", {}).get("observations"), f"{relative_path}/{case.get('id')}: oracle observations missing")
        require(case.get("oracle", {}).get("assertions"), f"{relative_path}/{case.get('id')}: oracle assertions missing")
        for clause_id in clause_ids:
            require(clause_id in clause_owner, f"{relative_path}: unknown clause {clause_id}")
            require(clause_owner[clause_id] == family_id, f"{relative_path}: {clause_id} belongs to another family")
            covered.add(clause_id)
    return covered


def validate_harness(
    relative_path: str,
    standard_id: str,
    suite_id: str,
    harness_status: str,
    case_ids: set[str],
) -> None:
    manifest = load_json(relative_path)
    require(manifest.get("schemaVersion") == 1, f"{relative_path}: schemaVersion must be 1")
    require(manifest.get("standardId") == standard_id, f"{relative_path}: standardId mismatch")
    require(manifest.get("suiteId") == suite_id, f"{relative_path}: suiteId mismatch")
    require(manifest.get("status") == harness_status, f"{relative_path}: status differs from kit")
    require(
        manifest.get("observationSchema") == "schemas/conformance-observations.schema.json",
        f"{relative_path}: observation schema must be the shared schema",
    )
    for key in ("fixturePath", "oraclePath", "observationSchema", "providerProtocol"):
        target = manifest.get(key)
        require(isinstance(target, str) and target, f"{relative_path}: {key} is missing")
        require((ROOT / target).is_file(), f"{relative_path}: {key} does not exist: {target}")
    dependencies = manifest.get("fixtureDependencyPaths", [])
    require(len(dependencies) == len(set(dependencies)), f"{relative_path}: duplicate fixture dependency")
    for dependency in dependencies:
        require(
            isinstance(dependency, str) and (ROOT / dependency).is_file(),
            f"{relative_path}: fixture dependency does not exist: {dependency}",
        )
    calibration = manifest.get("calibrationPath")
    if calibration is not None:
        require(
            isinstance(calibration, str) and (ROOT / calibration).is_file(),
            f"{relative_path}: calibration path does not exist: {calibration}",
        )
    covered = manifest.get("coveredCaseIds", [])
    require(covered and len(covered) == len(set(covered)), f"{relative_path}: covered case IDs must be present and unique")
    require(set(covered) <= case_ids, f"{relative_path}: harness names an unknown case")
    adapters = manifest.get("providerAdapters", [])
    require(len(adapters) == len(set(adapters)), f"{relative_path}: duplicate provider adapter")
    require(set(adapters) <= FIRST_CLASS, f"{relative_path}: unknown first-class provider adapter")
    if harness_status == "complete":
        require(set(covered) == case_ids, f"{relative_path}: complete harness must cover every case")
        require(set(adapters) == FIRST_CLASS, f"{relative_path}: complete harness needs every first-class adapter")


def validate_kit(contract: dict, requirements: dict, kit: dict, clause_owner: dict[str, str]) -> None:
    require(kit.get("schemaVersion") == 1, "kit schemaVersion must be 1")
    require(kit.get("standardId") == contract.get("contractId"), "kit standardId does not match contract")
    require(kit.get("requirementsRegistry") == contract.get("requirementsRegistry"), "kit requirements registry differs from contract")
    expected_document_status = "frozen" if contract.get("releaseStatus") in {"release-candidate", "standard"} else "draft"
    require(kit.get("status") == expected_document_status, "kit document status differs from release stage")

    requirements_by_family = {family["id"]: family for family in requirements["families"]}
    suites = kit.get("suites", [])
    suite_ids = [suite.get("id") for suite in suites]
    suite_families = [suite.get("familyId") for suite in suites]
    require(len(suite_ids) == len(set(suite_ids)), "kit suite IDs must be unique")
    require(len(suite_families) == len(set(suite_families)), "kit may define only one suite per family")
    require(set(suite_families) == set(requirements_by_family), "kit and requirements family sets differ")

    for suite in suites:
        family_id = suite["familyId"]
        family = requirements_by_family[family_id]
        expected = family["conformance"]
        require(suite.get("id") == expected.get("suiteId"), f"{family_id}: suite ID differs from requirements")
        for key in ("fixtureStatus", "oracleStatus", "harnessStatus"):
            require(suite.get(key) == expected.get(key), f"{family_id}: {key} differs from requirements")
        cases_path = suite.get("casesPath")
        harness_path = suite.get("harnessPath")
        statuses = [suite[key] for key in ("fixtureStatus", "oracleStatus", "harnessStatus")]
        if all(value == "planned" for value in statuses):
            require(cases_path is None, f"{family_id}: fully planned suite must not claim case definitions")
            require(harness_path is None, f"{family_id}: planned harness must not claim an implementation")
            continue
        require(isinstance(cases_path, str) and cases_path, f"{family_id}: started suite needs casesPath")
        require((ROOT / cases_path).is_file(), f"{family_id}: casesPath does not exist")
        covered = validate_cases(cases_path, contract["contractId"], suite["id"], clause_owner, family_id)
        case_file = load_json(cases_path)
        require(case_file.get("status") == kit.get("status"), f"{family_id}: cases status differs from kit")
        case_ids = {case["id"] for case in case_file["cases"]}
        expected_clauses = {clause_id for clause_id, owner in clause_owner.items() if owner == family_id}
        require(covered == expected_clauses, f"{family_id}: draft cases must cover every defined clause")
        if suite["harnessStatus"] == "planned":
            require(harness_path is None, f"{family_id}: planned harness must not claim an implementation")
        else:
            require(isinstance(harness_path, str) and harness_path, f"{family_id}: started harness needs harnessPath")
            require((ROOT / harness_path).is_file(), f"{family_id}: harnessPath does not exist")
            validate_harness(
                harness_path,
                contract["contractId"],
                suite["id"],
                suite["harnessStatus"],
                case_ids,
            )

    if contract.get("releaseStatus") in {"release-candidate", "standard"}:
        incomplete = [
            suite["id"]
            for suite in suites
            if any(suite[key] != "complete" for key in ("fixtureStatus", "oracleStatus", "harnessStatus"))
        ]
        require(not incomplete, f"release is blocked by incomplete conformance suites: {incomplete}")


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
        validate_schema_documents()
        contract = load_json("standard/contract.json")
        requirements = load_json("standard/requirements.json")
        kit = load_json("conformance/kit.json")
        registry = load_json("conformance/registry.json")
        validate_contract(contract)
        clause_owner = validate_requirements(contract, requirements)
        validate_kit(contract, requirements, kit, clause_owner)
        validate_registry(contract, registry)
    except (KeyError, TypeError, ValidationError) as error:
        print(f"governance validation failed: {error}", file=sys.stderr)
        return 1

    print(
        "governance validation passed: "
        f"{len(contract['capabilityFamilies'])} mandatory capability families, "
        f"{len(clause_owner)} draft clauses, "
        f"{len(kit['suites'])} conformance suites, "
        f"{len(registry['backends'])} backend records, 0 capability profiles"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
