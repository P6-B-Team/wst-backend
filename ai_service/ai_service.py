"""
Student Training Risk AI Service (WST-FR-14) — Logistic Regression.

Run:   uvicorn ai_service:app --port 8001
Needs: Students_Performance_Dataset.csv (or Students_Performance_Cleaned.csv) in the same folder.

Environment (all optional):
  STUDENTS_CSV        path of the CSV (default: the Cleaned file if present, else the Dataset file)
  INTERNAL_AI_TOKEN   if set, every POST must send the header  X-Internal-Token: <value>
  CLASS_WEIGHT        set to "balanced" to trade precision for recall on the small failing group
"""
import os
from typing import Optional

import joblib
import pandas as pd
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split

MODEL_VERSION = "logistic-regression-v1"
INTERNAL_TOKEN = os.getenv("INTERNAL_AI_TOKEN", "")

# Only learning-activity columns are loaded. Names, emails, gender, age, family income and
# parent education are never read, so they can never reach the model (brief: no protected attributes).
USE_COLS = [
    "Attendance (%)", "Assignments_Avg", "Quizzes_Avg", "Projects_Score",
    "Midterm_Score", "Final_Score", "Total_Score",
]


def find_csv() -> str:
    if os.getenv("STUDENTS_CSV"):
        return os.environ["STUDENTS_CSV"]
    for name in ("Students_Performance_Cleaned.csv", "Students_Performance_Dataset.csv"):
        if os.path.exists(name):
            return name
    raise FileNotFoundError(
        "Put Students_Performance_Dataset.csv (or Students_Performance_Cleaned.csv) next to ai_service.py"
    )


students_df = pd.read_csv(find_csv(), usecols=USE_COLS)

students_df["attendanceRate"] = students_df["Attendance (%)"] / 100

students_df["missingAssessments"] = (
    students_df[["Assignments_Avg", "Quizzes_Avg", "Projects_Score"]] < 60
).sum(axis=1)

students_df["unmetCompetencies"] = (
    students_df[["Midterm_Score", "Final_Score"]] < 60
).sum(axis=1)

features = ["attendanceRate", "missingAssessments", "unmetCompetencies"]

X = students_df[features]
y = (students_df["Total_Score"] < 60).astype(int)

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

model = LogisticRegression(
    max_iter=1000,
    class_weight="balanced" if os.getenv("CLASS_WEIGHT") == "balanced" else None,
)
model.fit(X_train, y_train)

# Hold-out evaluation + the "always predict pass" baseline, for the AI release gate.
_pred = model.predict(X_test)
_prob = model.predict_proba(X_test)[:, 1]
METRICS = {
    "rows": int(len(students_df)),
    "testRows": int(len(y_test)),
    "failingShare": round(float(y.mean()), 4),
    "accuracy": round(float(accuracy_score(y_test, _pred)), 4),
    "precision": round(float(precision_score(y_test, _pred, zero_division=0)), 4),
    "recall": round(float(recall_score(y_test, _pred, zero_division=0)), 4),
    "rocAuc": round(float(roc_auc_score(y_test, _prob)), 4),
    "baselineAccuracyAlwaysPass": round(float(1 - y_test.mean()), 4),
}

joblib.dump(model, "training_risk_model.pkl")

app = FastAPI(title="Student Training Risk AI Service", version="1.0.0")


class StudentRiskRequest(BaseModel):
    studentId: str
    attendanceRate: float
    missingAssessments: int
    unmetCompetencies: int


def check_token(token: Optional[str]) -> None:
    if INTERNAL_TOKEN and token != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Internal-Token")


@app.get("/")
def root():
    return {"service": "Student Training Risk AI", "status": "running", "model": MODEL_VERSION}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ai/model-info")
def model_info():
    return {
        "model": {"version": MODEL_VERSION, "type": "LogisticRegression", "features": features},
        "metrics": METRICS,
        "limitations": [
            "Trained on a public student-performance dataset, not on WST training data.",
            "The label (Total_Score < 60) is built from the same scores the features come from.",
            "Only a small share of students fail, so recall is low unless CLASS_WEIGHT=balanced.",
            "Advisory only: a human decides; the backend keeps a rule-based fallback.",
        ],
    }


@app.post("/ai/student-risk")
def predict_student_risk(
    request: StudentRiskRequest,
    x_internal_token: Optional[str] = Header(default=None),
):
    check_token(x_internal_token)

    # Accept a 0..1 ratio or a 0..100 percentage.
    rate = request.attendanceRate / 100 if request.attendanceRate > 1 else request.attendanceRate
    rate = min(max(rate, 0.0), 1.0)

    input_data = pd.DataFrame([{
        "attendanceRate": rate,
        "missingAssessments": max(request.missingAssessments, 0),
        "unmetCompetencies": max(request.unmetCompetencies, 0),
    }])

    probability = float(model.predict_proba(input_data)[0][1])

    if probability >= 0.70:
        band = "HIGH"
    elif probability >= 0.40:
        band = "MEDIUM"
    else:
        band = "LOW"

    contributions = []
    for feature, value, coefficient in zip(features, input_data.iloc[0].values, model.coef_[0]):
        impact = "high" if abs(coefficient * value) >= 0.5 else "low"
        contributions.append({"feature": feature, "value": float(value), "impact": impact})

    return {
        "studentId": request.studentId,
        "score": round(probability, 4),
        "band": band,
        "riskLevel": band,
        "completionProbability": round(1 - probability, 4),
        "baselineUsed": False,
        "fallbackActive": False,
        "explanation": {"contributions": contributions},
        "model": {"version": MODEL_VERSION},
    }
