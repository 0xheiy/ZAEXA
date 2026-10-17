"""Offline scanner decision tests; no RPC or third-party packages required."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

class Report:
    def __init__(self):
        self.is_proxy = False
        self.findings = []
    def add(self, level, title, detail):
        self.findings.append(SimpleNamespace(level=level, title=title, detail=detail))

def functions():
    source = Path(__file__).resolve().parents[1] / "scanner.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in
                 {"check_proxy", "adjust_severity_by_ownership"}]
    namespace = {"Web3": SimpleNamespace(to_checksum_address=lambda value: value),
                 "TokenReport": Report, "EIP1967_IMPL_SLOT": 1, "_safe_call": lambda fn: fn()}
    exec(compile(tree, str(source), "exec"), namespace)
    return namespace

class SecurityTests(unittest.TestCase):
    def test_beacon_detected_when_implementation_slot_empty(self):
        report = Report()
        eth = SimpleNamespace(get_storage_at=lambda _address, slot: bytes(32) if slot == 1 else bytes([1])*32)
        functions()["check_proxy"](SimpleNamespace(eth=eth), report, "token")
        self.assertTrue(report.is_proxy)
        self.assertTrue(any(f.level == "high" and "beacon" in f.title for f in report.findings))

    def test_absent_owner_cannot_downgrade_other_admin_risks(self):
        report = Report()
        report.add("critical", "Mint", "An administrator could exist without owner().")
        functions()["adjust_severity_by_ownership"](report)
        self.assertEqual(report.findings[0].level, "critical")

    def test_empty_standard_slots_do_not_prove_immutability(self):
        report = Report()
        eth = SimpleNamespace(get_storage_at=lambda _address, _slot: bytes(32))
        functions()["check_proxy"](SimpleNamespace(eth=eth), report, "token")
        self.assertFalse(report.is_proxy)
        self.assertTrue(all(f.level == "info" for f in report.findings))
        self.assertTrue(any("اثبات نشده" in f.detail for f in report.findings))

if __name__ == "__main__":
    unittest.main()
