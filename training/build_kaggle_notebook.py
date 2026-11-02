"""
Membuat kaggle_train.ipynb dari preprocess.py + train.py di folder ini.
Jalankan ulang setiap kali salah satu file itu berubah:  python build_kaggle_notebook.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def src(text):
    lines = text.splitlines(keepends=True)
    return lines


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": src(text)}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src(text)}


def read(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


cells = [
    md("# Training model Retinopati Diabetik (APTOS 2019)\n\n"
       "Syarat: **Accelerator = GPU T4 x2 / P100**, **Internet = On**, dan dataset kompetisi "
       "`aptos2019-blindness-detection` sudah ditambahkan lewat *Add Input*.\n\n"
       "Jalankan semua sel dari atas (*Run All*). Hasil akhir: `/kaggle/working/hasil/`."),
    code("!pip install -q onnx onnxruntime\n"
         "import torch\n"
         "print('PyTorch', torch.__version__, '| GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'TIDAK ADA')\n"
         "assert torch.cuda.is_available(), 'GPU belum aktif: Settings > Accelerator > GPU T4 x2'"),
    code("# Cari folder dataset (lokasi di /kaggle/input bisa berbeda tergantung cara dataset ditambahkan)\n"
         "import glob, os\n"
         "found = [os.path.dirname(p) for p in glob.glob('/kaggle/input/**/train.csv', recursive=True)\n"
         "         if os.path.isdir(os.path.join(os.path.dirname(p), 'train_images'))]\n"
         "assert found, 'Dataset APTOS tidak ditemukan. Klik Add Input > cari aptos2019-blindness-detection'\n"
         "DATA_DIR = found[0]\n"
         "print('DATA_DIR =', DATA_DIR, '|', len(os.listdir(os.path.join(DATA_DIR, 'train_images'))), 'gambar')"),
    code("%%writefile preprocess.py\n" + read("preprocess.py")),
    code("%%writefile train.py\n" + read("train.py")),
    md("## Training\n\nPreprocessing awal sekitar 5–10 menit, lalu tiap epoch beberapa menit. "
       "Ubah `--epochs` atau `--model` (misal `efficientnet_b3`) jika perlu."),
    code("!python train.py --data_dir {DATA_DIR} --out /kaggle/working/output --epochs 15"),
    md("## Hasil di data uji (test)\n\nIni angka yang jujur untuk dilaporkan."),
    code("import json\n"
         "meta = json.load(open('/kaggle/working/output/metadata.json'))\n"
         "LABELS = meta['labels']\n"
         "print('Ambang rujukan P(grade >= 2):', round(meta['referable_prob_threshold'], 4))\n"
         "for name in ('val_metrics', 'test_metrics'):\n"
         "    m = meta[name]\n"
         "    auc = m['referable_auc']\n"
         "    print(f\"\\n{name.upper()}: kappa={m['kappa']:.4f}  akurasi={m['accuracy']:.4f}  \"\n"
         "          f\"macro_precision={m['macro_precision']:.4f}  macro_recall={m['macro_recall']:.4f}  \"\n"
         "          f\"macro_f1={m['macro_f1']:.4f}  weighted_f1={m['weighted_f1']:.4f}\")\n"
         "    print(f\"  Rujukan (grade >= 2): akurasi={m['referable_accuracy']:.3f}  precision={m['referable_precision']:.3f}  \"\n"
         "          f\"recall/sensitivitas={m['referable_sensitivity']:.3f}  f1={m['referable_f1']:.3f}  \"\n"
         "          f\"spesifisitas={m['referable_specificity']:.3f}  npv={m['referable_npv']:.3f}  \"\n"
         "          f\"auc={auc if auc is None else round(auc, 4)}  {m['referable_counts']}\")\n"
         "\n"
         "o = meta['onnx_test_metrics']\n"
         "print(f\"\\nONNX (file untuk server) di TEST: kappa={o['kappa']:.4f}  akurasi={o['accuracy']:.4f}  \"\n"
         "      f\"macro_f1={o['macro_f1']:.4f}  f1_rujukan={o['referable_f1']:.3f}  \"\n"
         "      f\"prediksi sama dengan PyTorch={meta['onnx_test_pred_agreement']:.4f}\")\n"
         "\n"
         "t = meta['test_metrics']\n"
         "print('\\nPer grade, TEST:')\n"
         "print(f\"{'':<15}{'precision':>10}{'recall':>8}{'f1':>8}{'n':>6}\")\n"
         "for r in t['per_grade']:\n"
         "    print(f\"{r['grade']} {r['label']:<13}{r['precision']:>10.3f}{r['recall']:>8.3f}{r['f1']:>8.3f}{r['support']:>6}\")\n"
         "\n"
         "print('\\nConfusion matrix TEST (baris = label asli, kolom = prediksi):')\n"
         "print(' ' * 14 + ''.join(f'{g:>6}' for g in range(5)))\n"
         "for g, row in enumerate(t['confusion_matrix']):\n"
         "    print(f'{g} {LABELS[g]:<12}' + ''.join(f'{n:>6}' for n in row))"),
    md("## Siapkan file untuk diunduh"),
    code("import shutil\n"
         "os.makedirs('/kaggle/working/hasil', exist_ok=True)\n"
         "for f in ('dr_model.onnx', 'metadata.json'):\n"
         "    shutil.copy(f'/kaggle/working/output/{f}', '/kaggle/working/hasil/')\n"
         "shutil.rmtree('/kaggle/working/output/cache', ignore_errors=True)  # cache preprocessing, tidak perlu diunduh\n"
         "shutil.make_archive('/kaggle/working/hasil', 'zip', '/kaggle/working/hasil')\n"
         "print('Unduh /kaggle/working/hasil.zip dari panel Output di kanan.')\n"
         "!ls -lh /kaggle/working/hasil /kaggle/working/hasil.zip"),
]

nb = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}
for i, c in enumerate(nb["cells"]):
    c["id"] = f"cell-{i}"

with open(os.path.join(HERE, "kaggle_train.ipynb"), "w") as f:
    json.dump(nb, f, indent=1, ensure_ascii=False)
print("kaggle_train.ipynb dibuat")
