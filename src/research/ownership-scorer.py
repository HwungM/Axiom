import json
import sys
from pathlib import Path

import joblib
import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "models" / "ownership-curve-v1.json").read_text(encoding="utf-8"))
MODEL = joblib.load(ROOT / "models" / "ownership-curve-v1.joblib")
FEATURES = CONFIG["features"]

print(json.dumps({"ready": True, "version": CONFIG["version"], "threshold": CONFIG["threshold"]}), flush=True)
for line in sys.stdin:
    try:
        payload = json.loads(line)
        row = {feature: payload.get(feature) for feature in FEATURES}
        score = float(MODEL.predict(pd.DataFrame([row], columns=FEATURES))[0])
        print(json.dumps({
            "id": payload.get("id"),
            "score": score,
            "threshold": CONFIG["threshold"],
            "passed": score >= CONFIG["threshold"],
        }), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}), flush=True)

