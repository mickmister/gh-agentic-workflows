from pathlib import Path
import re
import unittest


class NoWorkflowArtifacts(unittest.TestCase):
    def test_workflows_and_composites_cannot_reintroduce_artifact_actions(self):
        root = Path(__file__).resolve().parents[1]
        prohibited = re.compile(r'(?m)^\s*(?:-\s+)?uses:\s*[\'\"]?actions/(?:upload|download)(?:-pages)?-artifact@')
        for directory in (root / 'workflows', root / 'actions'):
            for path in directory.rglob('*'):
                if path.suffix not in ('.yml', '.yaml'):
                    continue
                with self.subTest(path=path.relative_to(root)):
                    self.assertIsNone(prohibited.search(path.read_text()), 'Use private S3 instead of workflow artifacts')

    def test_observability_forbids_even_trace_context_artifacts(self):
        root = Path(__file__).resolve().parents[1]
        action = (root / 'actions/observability/action.yml').read_text()
        self.assertRegex(action, r'(?m)^\s+artifacts: disabled\s*$')
        self.assertIn('PRIVATE_OBSERVABILITY_TRACEPARENT', action)
        self.assertNotRegex(action, r'OTEL_(?:TRACES|LOGS|METRICS)_EXPORTER: deferred')


if __name__ == '__main__':
    unittest.main()
