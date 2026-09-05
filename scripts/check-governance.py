#!/usr/bin/env python3
"""Validate the cross-file invariants of the Edge Canon governance records."""

from __future__ import annotations

import hashlib
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
    for schema_path in sorted((ROOT / "schemas").glob("*.json")):
        relative = schema_path.relative_to(ROOT).as_posix()
        schema = load_json(relative)
        try:
            jsonschema.Draft202012Validator.check_schema(schema)
        except jsonschema.SchemaError as error:
            raise ValidationError(f"{relative}: invalid JSON Schema: {error.message}") from error

    documents = {
        "standard/contract.json": "schemas/standard-contract.schema.json",
        "standard/requirements.json": "schemas/requirements-registry.schema.json",
        "conformance/kit.json": "schemas/conformance-kit.schema.json",
        "conformance/cases/web-fetch-events.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/web-fetch-events/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/cases/canonical-build-artifact.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/canonical-build-artifact/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/cases/routing-static-assets.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/routing-static-assets/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/cases/streams-websockets-background-work.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/streams-websockets-background-work/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/cases/node-npm-subset.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/node-npm-subset/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/cases/environment-secrets.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/environment-secrets/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/evidence/node-npm-subset-platforms-2026-09-04.json": "schemas/conformance-platform-evidence.schema.json",
        "conformance/evidence/streams-websockets-background-work-platforms-2026-09-04.json": "schemas/conformance-platform-evidence.schema.json",
        "conformance/cases/web-platform-apis.json": "schemas/conformance-cases.schema.json",
        "conformance/harness/web-platform-apis/harness.json": "schemas/conformance-harness.schema.json",
        "conformance/evidence/canonical-build-artifact-platforms-2026-09-04.json": "schemas/conformance-platform-evidence.schema.json",
        "conformance/evidence/routing-static-assets-platforms-2026-09-04.json": "schemas/conformance-platform-evidence.schema.json",
        "conformance/evidence/web-platform-apis-platforms-2026-09-04.json": "schemas/conformance-platform-evidence.schema.json",
        "conformance/harness/web-fetch-events/sample-pass.json": "schemas/conformance-observations.schema.json",
        "conformance/harness/web-fetch-events/provider-adapters/deislet/adapter.json": "schemas/conformance-provider-adapter.schema.json",
        "conformance/harness/web-fetch-events/provider-adapters/cloudflare-workers-pages/adapter.json": "schemas/conformance-provider-adapter.schema.json",
        "conformance/harness/web-fetch-events/provider-adapters/tencent-edgeone-makers/adapter.json": "schemas/conformance-provider-adapter.schema.json",
        "conformance/registry.json": "schemas/conformance-registry.schema.json",
    }
    for relative, schema_relative in documents.items():
        schema = load_json(schema_relative)
        try:
            jsonschema.Draft202012Validator(
                schema,
                format_checker=jsonschema.FormatChecker(),
            ).validate(load_json(relative))
        except jsonschema.SchemaError as error:
            raise ValidationError(f"{schema_relative}: invalid JSON Schema: {error.message}") from error
        except jsonschema.ValidationError as error:
            location = "/".join(str(part) for part in error.absolute_path) or "<root>"
            raise ValidationError(f"{relative}/{location}: {error.message}") from error

    standard_version = "edge-canon.next@" + "0" * 40
    declarations = {
        "schemaVersion": 1,
        "format": "edge-canon.environment-secrets/v1",
        "standardVersion": standard_version,
        "access": {"surface": "context.env", "extraProviderBindings": "excluded"},
        "limits": {"bindingCount": 64, "valueBytes": 5120, "measurement": "utf-8"},
        "declarations": [
            {"name": "MODE", "kind": "config", "valueType": "string", "required": True},
            {"name": "SETTINGS", "kind": "config", "valueType": "json", "required": True},
            {"name": "TOKEN", "kind": "secret", "valueType": "string", "required": True},
        ],
    }
    declaration_schema = load_json("schemas/environment-secrets.schema.json")
    snapshot_schema = load_json("schemas/environment-binding-snapshot.schema.json")
    snapshot = {
        "schemaVersion": 1,
        "format": "edge-canon.environment-binding-snapshot/v1",
        "standardVersion": standard_version,
        "deploymentVersionId": "deployment-1",
        "environmentId": "production",
        "declarationsSha256": "0" * 64,
        "activation": {
            "mode": "version-bound-atomic",
            "missingRequired": "reject",
            "unavailableSecretRevision": "reject",
        },
        "bindings": [
            {"name": "MODE", "kind": "config", "valueType": "string", "revision": "ab8e18ef4ebebeddc0b3152ce9c9006e14fc05242e3fc9ce32246ea6a9543074", "value": "production"},
            {"name": "SETTINGS", "kind": "config", "valueType": "json", "revision": "13f513fe32a8991557ebf28941b75597641e94717c08569b7723d998c7428423", "value": {"safe": True}},
            {"name": "TOKEN", "kind": "secret", "valueType": "string", "revision": "token-1"},
        ],
    }
    jsonschema.validate(declarations, declaration_schema)
    jsonschema.validate(snapshot, snapshot_schema)
    secret_with_plaintext = json.loads(json.dumps(snapshot))
    secret_with_plaintext["bindings"][2]["value"] = "must-not-be-accepted"
    try:
        jsonschema.validate(secret_with_plaintext, snapshot_schema)
    except jsonschema.ValidationError:
        pass
    else:
        raise ValidationError("environment snapshot schema accepted a plaintext secret")
    secret_json = json.loads(json.dumps(declarations))
    secret_json["declarations"][2]["valueType"] = "json"
    try:
        jsonschema.validate(secret_json, declaration_schema)
    except jsonschema.ValidationError:
        pass
    else:
        raise ValidationError("environment declaration schema accepted secret/json")


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
    execution_kind = manifest.get("executionKind")
    require(execution_kind in {"provider-deployment", "local-reference"}, f"{relative_path}: invalid execution kind")
    require(
        manifest.get("observationSchema") == "schemas/conformance-observations.schema.json",
        f"{relative_path}: observation schema must be the shared schema",
    )
    for key in ("fixturePath", "oraclePath", "observationSchema"):
        target = manifest.get(key)
        require(isinstance(target, str) and target, f"{relative_path}: {key} is missing")
        require((ROOT / target).is_file(), f"{relative_path}: {key} does not exist: {target}")

    provider_paths = (
        "providerProtocol",
        "providerAdapterSchema",
        "providerAdapterRequestSchema",
        "providerAdapterResultSchema",
        "canonicalArtifactSchema",
        "derivedArtifactSchema",
        "providerDeploymentStateSchema",
        "providerInvocationStateSchema",
        "providerCollectionStateSchema",
        "canonicalArtifactBuilder",
    )
    reference_paths = ("contractSchema", "validatorPath", "runnerPath")
    for key in provider_paths if execution_kind == "provider-deployment" else reference_paths:
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
    if execution_kind == "local-reference":
        require(
            set(manifest.get("platforms", [])) == {"linux", "macos", "windows"},
            f"{relative_path}: local reference harness must cover Linux, macOS, and Windows",
        )
        if harness_status == "complete":
            require(set(covered) == case_ids, f"{relative_path}: complete harness must cover every case")
        return

    adapters = manifest.get("providerAdapters", [])
    require(len(adapters) == len(set(adapters)), f"{relative_path}: duplicate provider adapter")
    require(set(adapters) <= FIRST_CLASS, f"{relative_path}: unknown first-class provider adapter")

    adapter_paths = manifest.get("providerAdapterPaths", [])
    require(len(adapter_paths) == len(set(adapter_paths)), f"{relative_path}: duplicate provider adapter path")
    adapter_manifests = []
    for adapter_path in adapter_paths:
        require(isinstance(adapter_path, str) and adapter_path, f"{relative_path}: invalid provider adapter path")
        require((ROOT / adapter_path).is_file(), f"{relative_path}: provider adapter does not exist: {adapter_path}")
        adapter = load_json(adapter_path)
        adapter_manifests.append(adapter)
        require(adapter.get("standardId") == standard_id, f"{adapter_path}: standardId mismatch")
        require(adapter.get("suiteId") == suite_id, f"{adapter_path}: suiteId mismatch")
        require(adapter.get("protocolVersion") == "edge-canon.provider-adapter/v1", f"{adapter_path}: protocolVersion mismatch")
        entrypoint = adapter.get("entrypoint")
        require(isinstance(entrypoint, str) and (ROOT / entrypoint).is_file(), f"{adapter_path}: entrypoint does not exist")
        coverage = adapter.get("caseCoverage", [])
        coverage_ids = [item.get("id") for item in coverage]
        require(len(coverage_ids) == len(set(coverage_ids)), f"{adapter_path}: duplicate case coverage")
        require(set(coverage_ids) == case_ids, f"{adapter_path}: case coverage differs from suite")
        complete = adapter.get("status") == "complete"
        if complete:
            require(all(item.get("status") == "implemented" and not item.get("blockers") for item in coverage), f"{adapter_path}: complete adapter has incomplete cases")
            require(all(item.get("status") == "implemented" for item in adapter.get("operations", {}).values()), f"{adapter_path}: complete adapter has incomplete operations")
            require(not adapter.get("limitations"), f"{adapter_path}: complete adapter still has limitations")

    adapter_ids = [adapter.get("backendId") for adapter in adapter_manifests]
    require(len(adapter_ids) == len(set(adapter_ids)), f"{relative_path}: duplicate adapter backend")
    require(set(adapter_ids) == FIRST_CLASS, f"{relative_path}: adapter manifests must cover every first-class backend")
    completed_ids = {adapter["backendId"] for adapter in adapter_manifests if adapter.get("status") == "complete"}
    require(set(adapters) == completed_ids, f"{relative_path}: completed provider adapter list differs from manifests")
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


def validate_platform_evidence(relative_path: str, kit: dict) -> None:
    evidence = load_json(relative_path)
    observations = evidence.get("observations", [])
    platforms = [item.get("platform") for item in observations]
    require(
        set(platforms) == {"linux", "macos", "windows"} and len(platforms) == 3,
        f"{relative_path}: evidence must contain one result for each supported platform",
    )
    artifact_sha256 = evidence.get("artifactSha256")
    require(
        all(item.get("artifactSha256") == artifact_sha256 for item in observations),
        f"{relative_path}: platform artifact identities differ",
    )
    case_counts = {item.get("caseCount") for item in observations}
    require(len(case_counts) == 1, f"{relative_path}: platform case counts differ")
    suites = {suite["id"]: suite for suite in kit.get("suites", [])}
    suite = suites.get(evidence.get("suiteId"))
    require(suite is not None and suite.get("casesPath"), f"{relative_path}: evidence suite has no case document")
    expected_case_count = len(load_json(suite["casesPath"]).get("cases", []))
    require(case_counts == {expected_case_count}, f"{relative_path}: evidence case count differs from its suite")
    implementation_path = evidence.get("referenceImplementationPath")
    require(isinstance(implementation_path, str), f"{relative_path}: reference implementation path is missing")
    implementation = ROOT / implementation_path
    require(implementation.is_file(), f"{relative_path}: reference implementation does not exist")
    implementation_sha256 = hashlib.sha256(implementation.read_bytes()).hexdigest()
    require(
        implementation_sha256 == evidence.get("referenceImplementationSha256"),
        f"{relative_path}: reference implementation digest differs",
    )


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
        validate_platform_evidence("conformance/evidence/canonical-build-artifact-platforms-2026-09-04.json", kit)
        validate_platform_evidence("conformance/evidence/routing-static-assets-platforms-2026-09-04.json", kit)
        validate_platform_evidence("conformance/evidence/streams-websockets-background-work-platforms-2026-09-04.json", kit)
        validate_platform_evidence("conformance/evidence/node-npm-subset-platforms-2026-09-04.json", kit)
        validate_platform_evidence("conformance/evidence/web-platform-apis-platforms-2026-09-04.json", kit)
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
