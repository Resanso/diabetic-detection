"""
Training model klasifikasi Diabetic Retinopathy (grade 0-4) dengan dataset APTOS 2019,
lalu export ke ONNX agar bisa dijalankan di server ringan (laptop / Raspberry Pi / VPS).

Jalankan di Kaggle Notebook (GPU T4/P100) atau Google Colab:
    python train.py --data_dir /kaggle/input/aptos2019-blindness-detection --epochs 15

Output (folder --out):
    best_model.pth     bobot PyTorch terbaik
    dr_model.onnx      model untuk server
    metadata.json      info preprocessing + label + metrik
"""
import argparse
import json
import os
import random

import cv2
import numpy as np
import pandas as pd
import timm
import torch
import torch.nn as nn
from sklearn.metrics import cohen_kappa_score, confusion_matrix
from sklearn.model_selection import train_test_split
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms as T
from tqdm import tqdm

from preprocess import IMG_SIZE, MEAN, STD, ben_graham

LABELS = ["Tidak ada DR", "Ringan", "Sedang", "Berat", "Proliferatif"]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data_dir", required=True, help="Folder berisi train.csv dan train_images/")
    p.add_argument("--out", default="output")
    p.add_argument("--model", default="efficientnet_b0")
    p.add_argument("--epochs", type=int, default=15)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--workers", type=int, default=2)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--no_pretrained", action="store_true")
    return p.parse_args()


def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def cache_images(df, img_dir, cache_dir):
    """Preprocess sekali di awal supaya tiap epoch tidak mengulang proses berat."""
    os.makedirs(cache_dir, exist_ok=True)
    for id_code in tqdm(df.id_code, desc="Preprocessing"):
        dst = os.path.join(cache_dir, f"{id_code}.png")
        if os.path.exists(dst):
            continue
        img = cv2.imread(os.path.join(img_dir, f"{id_code}.png"))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img = ben_graham(img)
        cv2.imwrite(dst, cv2.cvtColor(img, cv2.COLOR_RGB2BGR))


class RetinaDataset(Dataset):
    def __init__(self, df, cache_dir, tf):
        self.df = df.reset_index(drop=True)
        self.cache_dir = cache_dir
        self.tf = tf

    def __len__(self):
        return len(self.df)

    def __getitem__(self, i):
        row = self.df.iloc[i]
        img = cv2.imread(os.path.join(self.cache_dir, f"{row.id_code}.png"))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        return self.tf(img), int(row.diagnosis)


train_tf = T.Compose([
    T.ToPILImage(),
    T.RandomHorizontalFlip(),
    T.RandomVerticalFlip(),
    T.RandomRotation(180),
    T.ColorJitter(brightness=0.2, contrast=0.2),
    T.ToTensor(),
    T.Normalize(MEAN.tolist(), STD.tolist()),
])
val_tf = T.Compose([
    T.ToPILImage(),
    T.ToTensor(),
    T.Normalize(MEAN.tolist(), STD.tolist()),
])


def evaluate(model, loader, device):
    model.eval()
    preds, targets = [], []
    with torch.no_grad():
        for x, y in loader:
            with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
                logits = model(x.to(device))
            preds.append(logits.argmax(1).cpu().numpy())
            targets.append(y.numpy())
    preds, targets = np.concatenate(preds), np.concatenate(targets)

    # Metrik skrining: "referable DR" = grade >= 2 (perlu dirujuk ke dokter mata)
    ref_p, ref_t = preds >= 2, targets >= 2
    tp = int((ref_p & ref_t).sum()); fn = int((~ref_p & ref_t).sum())
    tn = int((~ref_p & ~ref_t).sum()); fp = int((ref_p & ~ref_t).sum())
    return {
        "kappa": float(cohen_kappa_score(targets, preds, weights="quadratic")),
        "accuracy": float((preds == targets).mean()),
        "referable_sensitivity": tp / max(tp + fn, 1),
        "referable_specificity": tn / max(tn + fp, 1),
        "confusion_matrix": confusion_matrix(targets, preds, labels=range(5)).tolist(),
    }


def export_onnx(model, path):
    model.eval().cpu()
    dummy = torch.randn(1, 3, IMG_SIZE, IMG_SIZE)
    kwargs = dict(
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    try:
        torch.onnx.export(model, dummy, path, dynamo=False, **kwargs)
    except TypeError:  # versi PyTorch lama belum punya argumen dynamo
        torch.onnx.export(model, dummy, path, **kwargs)

    # Verifikasi: output ONNX harus sama dengan PyTorch
    import onnxruntime as ort
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out_onnx = sess.run(None, {"input": dummy.numpy()})[0]
    with torch.no_grad():
        out_torch = model(dummy).numpy()
    diff = float(np.abs(out_onnx - out_torch).max())
    print(f"ONNX diekspor ke {path} | selisih maks vs PyTorch: {diff:.2e}")
    return diff


def main():
    args = parse_args()
    seed_everything(args.seed)
    os.makedirs(args.out, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print("Device:", device)

    df = pd.read_csv(os.path.join(args.data_dir, "train.csv"))
    cache_dir = os.path.join(args.out, "cache")
    cache_images(df, os.path.join(args.data_dir, "train_images"), cache_dir)

    tr_df, va_df = train_test_split(df, test_size=0.15, stratify=df.diagnosis, random_state=args.seed)
    print("Distribusi kelas (train):", tr_df.diagnosis.value_counts().sort_index().tolist())

    tr_dl = DataLoader(RetinaDataset(tr_df, cache_dir, train_tf), batch_size=args.batch,
                       shuffle=True, num_workers=args.workers, pin_memory=True, drop_last=True)
    va_dl = DataLoader(RetinaDataset(va_df, cache_dir, val_tf), batch_size=args.batch,
                       shuffle=False, num_workers=args.workers, pin_memory=True)

    model = timm.create_model(args.model, pretrained=not args.no_pretrained, num_classes=5).to(device)

    # Bobot kelas: data APTOS tidak seimbang (grade 0 jauh lebih banyak)
    counts = np.bincount(tr_df.diagnosis, minlength=5).astype(np.float32)
    weights = torch.tensor((counts.sum() / counts) ** 0.5, dtype=torch.float32)
    weights = weights / weights.mean()
    criterion = nn.CrossEntropyLoss(weight=weights.to(device), label_smoothing=0.05)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=args.epochs * len(tr_dl), pct_start=0.1)
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    best_kappa, best_metrics = -1.0, None
    best_path = os.path.join(args.out, "best_model.pth")
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        for x, y in tqdm(tr_dl, desc=f"Epoch {epoch}/{args.epochs}"):
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, enabled=use_amp):
                loss = criterion(model(x), y)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            total += loss.item()

        m = evaluate(model, va_dl, device)
        print(f"Epoch {epoch}: loss={total / len(tr_dl):.4f} kappa={m['kappa']:.4f} "
              f"acc={m['accuracy']:.4f} sens_ref={m['referable_sensitivity']:.3f} "
              f"spec_ref={m['referable_specificity']:.3f}")
        if m["kappa"] > best_kappa:
            best_kappa, best_metrics = m["kappa"], m
            torch.save(model.state_dict(), best_path)
            print("  -> model terbaik disimpan")

    model.load_state_dict(torch.load(best_path, map_location="cpu"))
    onnx_path = os.path.join(args.out, "dr_model.onnx")
    diff = export_onnx(model, onnx_path)

    meta = {
        "model": args.model,
        "img_size": IMG_SIZE,
        "mean": MEAN.tolist(),
        "std": STD.tolist(),
        "labels": LABELS,
        "referable_threshold_grade": 2,
        "val_metrics": best_metrics,
        "onnx_max_diff": diff,
    }
    with open(os.path.join(args.out, "metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("Selesai. Salin dr_model.onnx dan metadata.json ke server/model/")


if __name__ == "__main__":
    main()
