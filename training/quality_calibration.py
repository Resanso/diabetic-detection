"""
Kalibrasi cek kualitas foto fundus (server/preprocess.py: quality_check) pada foto APTOS asli,
sekaligus menyiapkan set benchmark lab dari split test (foto yang tidak dipakai training).

Jalankan di Kaggle bersama dataset aptos2019-blindness-detection:
    python quality_calibration.py --data_dir /kaggle/input/aptos2019-blindness-detection --out /kaggle/working/qc

Output (folder --out):
    qc_report.json     ringkasan: tingkat lolos, jumlah tiap masalah, persentil tiap parameter
    qc_features.csv    parameter per foto
    benchmark/         10 foto asli per grade dari split test + manifest.json (format server/data/benchmark)
"""
import argparse
import json
import os
from collections import Counter

import cv2
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from tqdm import tqdm

from preprocess import QC, quality_check  # salinan server/preprocess.py

BENCH_LABELS = ["Tidak ada DR (Normal)", "Ringan (Mild)", "Sedang (Moderate)", "Berat (Severe)", "Proliferatif (PDR)"]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data_dir", required=True)
    p.add_argument("--out", default="qc")
    p.add_argument("--seed", type=int, default=42)       # harus sama dengan train.py agar split test sama
    p.add_argument("--test_size", type=float, default=0.15)
    p.add_argument("--per_grade", type=int, default=10)
    p.add_argument("--bench_max_side", type=int, default=1024)
    return p.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    df = pd.read_csv(os.path.join(args.data_dir, "train.csv"))
    img_dir = os.path.join(args.data_dir, "train_images")

    rows = []
    for r in tqdm(df.itertuples(), total=len(df), desc="Cek kualitas"):
        img = cv2.cvtColor(cv2.imread(os.path.join(img_dir, f"{r.id_code}.png")), cv2.COLOR_BGR2RGB)
        q = quality_check(img)
        rows.append({"id_code": r.id_code, "diagnosis": r.diagnosis, "ok": q["ok"], "is_fundus": q["is_fundus"],
                     "issues": "; ".join(q["issues"]),
                     **{k: v for k, v in q.items() if k not in ("ok", "is_fundus", "issues")}})
    feat = pd.DataFrame(rows)
    feat.to_csv(os.path.join(args.out, "qc_features.csv"), index=False)

    params = [c for c in feat.columns if c not in ("id_code", "diagnosis", "ok", "is_fundus", "issues")]
    issues = Counter(i for s in feat.issues for i in s.split("; ") if i)
    report = {
        "n": len(feat),
        "thresholds": QC,
        "is_fundus_rate": float(feat.is_fundus.mean()),
        "ok_rate": float(feat.ok.mean()),
        "ok_rate_per_grade": feat.groupby("diagnosis").ok.mean().round(4).to_dict(),
        "issue_counts": dict(issues.most_common()),
        "percentiles": {p: {q: round(float(feat[p].quantile(q / 100)), 3) for q in (0.5, 1, 5, 50, 95, 99, 99.5)}
                        for p in params},
        "not_fundus_examples": feat[~feat.is_fundus].id_code.head(20).tolist(),
    }
    with open(os.path.join(args.out, "qc_report.json"), "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"\nFoto APTOS: {report['n']}")
    print(f"Dikenali sebagai fundus: {report['is_fundus_rate']:.2%}   Lolos semua cek: {report['ok_rate']:.2%}")
    print("Lolos per grade:", report["ok_rate_per_grade"])
    print("Masalah:", report["issue_counts"])
    print(f"\n{'parameter':<14}" + "".join(f"{f'p{q}':>9}" for q in (0.5, 1, 5, 50, 95, 99, 99.5)))
    for p, v in report["percentiles"].items():
        print(f"{p:<14}" + "".join(f"{x:>9.3f}" for x in v.values()))

    # Benchmark lab: foto asli dari split test yang sama dengan train.py, hanya yang lolos cek kualitas
    _, te_df = train_test_split(df, test_size=args.test_size, stratify=df.diagnosis, random_state=args.seed)
    te = feat[feat.id_code.isin(te_df.id_code) & feat.ok]
    manifest = []
    for g in range(5):
        pick = te[te.diagnosis == g].sample(min(args.per_grade, (te.diagnosis == g).sum()), random_state=args.seed)
        os.makedirs(os.path.join(args.out, "benchmark", str(g)), exist_ok=True)
        for i, r in enumerate(pick.itertuples(), 1):
            img = cv2.imread(os.path.join(img_dir, f"{r.id_code}.png"))
            h, w = img.shape[:2]
            s = min(1.0, args.bench_max_side / max(h, w))
            if s < 1:
                img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
            name = f"grade_{g}_sample_{i:02d}.jpg"
            cv2.imwrite(os.path.join(args.out, "benchmark", str(g), name), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            manifest.append({"id": f"bench_{g}_{i:02d}", "filename": name, "grade": g, "label": BENCH_LABELS[g],
                             "referable": g >= 2, "source_id": r.id_code,
                             "url": f"/api/benchmark/image/{g}/{name}",
                             "local_path": f"server/data/benchmark/{g}/{name}"})
    with open(os.path.join(args.out, "benchmark", "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nBenchmark: {len(manifest)} foto asli dari split test ->", os.path.join(args.out, "benchmark"))


if __name__ == "__main__":
    main()
