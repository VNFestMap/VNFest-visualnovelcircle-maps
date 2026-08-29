from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "downloads" / "astrbot_plugin_galgamemap_beta0.6.zip"
EXPECTED_ROOT = "astrbot_plugin_galgamemap/"
EXPECTED_FILES = {
    "astrbot_plugin_galgamemap/__init__.py",
    "astrbot_plugin_galgamemap/_conf_schema.json",
    "astrbot_plugin_galgamemap/main.py",
    "astrbot_plugin_galgamemap/metadata.yaml",
    "astrbot_plugin_galgamemap/README.md",
    "astrbot_plugin_galgamemap/README.ja.md",
    "astrbot_plugin_galgamemap/USER_GUIDE.ja.md",
}


with ZipFile(PACKAGE) as archive:
    names = archive.namelist()

assert names[0] == EXPECTED_ROOT, (
    f"the first ZIP entry must be an explicit plugin directory, got {names[0]!r}"
)
assert set(names[1:]) == EXPECTED_FILES, "ZIP contents must be flat below the plugin root"
assert all("__pycache__" not in name for name in names), "ZIP must not contain __pycache__"

print("astrbot package layout regression test passed")
