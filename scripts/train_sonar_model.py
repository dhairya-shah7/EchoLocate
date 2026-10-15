"""
Dual-Branch Acoustic Fusion Neural Network Trainer & ONNX Exporter
Trains on 1D Cross-Correlation Envelopes and 2D Ultrasonic Spectrograms (18-22 kHz),
and exports the optimized `sonar_model_fusion.onnx` directly to Android assets.
"""

import os
import sys

# Ensure UTF-8 console output to prevent Windows cp1252 emoji crashes
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import TensorDataset, DataLoader

# Import dataset generator
sys.path.append(os.path.dirname(__file__))
from generate_acoustic_dataset import generate_dataset

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "sonar_dataset.npz")
WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "sonar_model_weights.pt")
ASSET_ONNX_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "android",
    "app",
    "src",
    "main",
    "assets",
    "sonar_model_fusion.onnx",
)

class DualBranchAcousticFusionNet(nn.Module):
    def __init__(self):
        super().__init__()
        # 1D Envelope Convolutional Branch
        self.env_conv = nn.Sequential(
            nn.Conv1d(1, 32, kernel_size=15, stride=2, padding=7),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=7, stride=2, padding=3),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(64, 128, kernel_size=5, stride=2, padding=2),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
            nn.Flatten(),  # 128
        )

        # 2D Spectrogram Convolutional Branch
        self.spec_conv = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(64, 128, kernel_size=3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((1, 1)),
            nn.Flatten(),  # 128
        )

        # Cross-Modal Fusion MLP
        self.fusion = nn.Sequential(
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, 64),
            nn.ReLU(),
        )

        # Output Heads
        self.range_head = nn.Linear(64, 1)      # Predicted distance (meters)
        self.angle_head = nn.Linear(64, 1)      # Azimuth angle (radians)
        self.dim_head = nn.Linear(64, 2)        # Width, Height
        self.class_head = nn.Linear(64, 4)      # 4 classes: SPECULAR, DIFFUSE, ABSORPTIVE, APERTURE
        self.conf_head = nn.Linear(64, 1)       # Confidence

    def forward(self, envelope, spectrogram):
        env_feat = self.env_conv(envelope)
        spec_feat = self.spec_conv(spectrogram)
        fused = self.fusion(torch.cat([env_feat, spec_feat], dim=1))

        pred_range = F.relu(self.range_head(fused))
        pred_angle = torch.tanh(self.angle_head(fused)) * 0.45
        pred_dims = F.relu(self.dim_head(fused))
        class_logits = self.class_head(fused)
        pred_class = torch.argmax(class_logits, dim=1, keepdim=True).float()
        pred_conf = torch.sigmoid(self.conf_head(fused))

        # Output Tensor format: [B, 6] -> [range, angle, width, height, type, confidence]
        # Matches use_sonar_inference.ts exactly!
        return torch.cat([
            pred_range,
            pred_angle,
            pred_dims[:, 0:1],
            pred_dims[:, 1:2],
            pred_class,
            pred_conf,
        ], dim=1)

def train_and_export():
    if not os.path.exists(DATA_PATH):
        print(f"Dataset not found at {DATA_PATH}, generating synthetic RIR dataset...")
        generate_dataset(num_samples_per_class=1250, save_path=DATA_PATH)

    print("Loading acoustic training data...")
    data = np.load(DATA_PATH)
    spectrograms = torch.from_numpy(data["spectrograms"])
    envelopes = torch.from_numpy(data["envelopes"])
    distances = torch.from_numpy(data["distances"])
    labels = torch.from_numpy(data["labels"])

    num_samples = len(labels)
    indices = np.random.permutation(num_samples)
    split = int(0.85 * num_samples)
    train_idx, val_idx = indices[:split], indices[split:]

    train_dataset = TensorDataset(
        envelopes[train_idx],
        spectrograms[train_idx],
        distances[train_idx],
        labels[train_idx],
    )
    val_dataset = TensorDataset(
        envelopes[val_idx],
        spectrograms[val_idx],
        distances[val_idx],
        labels[val_idx],
    )

    train_loader = DataLoader(train_dataset, batch_size=64, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=64, shuffle=False)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Training on device: {device}")

    model = DualBranchAcousticFusionNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    loss_mse = nn.MSELoss()
    loss_ce = nn.CrossEntropyLoss()

    epochs = 8
    print("Beginning training epochs...")
    for epoch in range(1, epochs + 1):
        model.train()
        train_loss = 0.0
        for env, spec, dist, lbl in train_loader:
            env, spec, dist, lbl = env.to(device), spec.to(device), dist.to(device), lbl.to(device)
            optimizer.zero_grad()

            env_feat = model.env_conv(env)
            spec_feat = model.spec_conv(spec)
            fused = model.fusion(torch.cat([env_feat, spec_feat], dim=1))

            pred_r = F.relu(model.range_head(fused)).squeeze(1)
            class_logits = model.class_head(fused)

            loss = loss_mse(pred_r, dist) + 1.5 * loss_ce(class_logits, lbl)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()

        # Validation phase
        model.eval()
        correct = 0
        total = 0
        val_range_err = 0.0
        with torch.no_grad():
            for env, spec, dist, lbl in val_loader:
                env, spec, dist, lbl = env.to(device), spec.to(device), dist.to(device), lbl.to(device)
                preds = model(env, spec)
                pred_r = preds[:, 0]
                pred_c = preds[:, 4].long()

                val_range_err += torch.mean(torch.abs(pred_r - dist)).item() * len(lbl)
                correct += (pred_c == lbl).sum().item()
                total += len(lbl)

        val_acc = (correct / total) * 100
        mean_r_err = val_range_err / total
        print(f"Epoch {epoch:02d}/{epochs:02d} | Train Loss: {train_loss/len(train_loader):.4f} | Val Accuracy: {val_acc:.1f}% | Mean Range Error: {mean_r_err:.3f}m", flush=True)

    # Save model weights checkpoint
    torch.save(model.state_dict(), WEIGHTS_PATH)
    print(f"Model weights saved to {WEIGHTS_PATH}", flush=True)

    print("\nTraining complete! Exporting model to ONNX format...", flush=True)
    model.eval()
    dummy_envelope = torch.randn(1, 1, 2000, device=device)
    dummy_spectrogram = torch.randn(1, 1, 64, 64, device=device)

    os.makedirs(os.path.dirname(ASSET_ONNX_PATH), exist_ok=True)
    torch.onnx.export(
        model,
        (dummy_envelope, dummy_spectrogram),
        ASSET_ONNX_PATH,
        input_names=["envelope", "spectrogram"],
        output_names=["predictions"],
        dynamic_axes={
            "envelope": {0: "batch_size"},
            "spectrogram": {0: "batch_size"},
            "predictions": {0: "batch_size"},
        },
        opset_version=18,
    )

    size_mb = os.path.getsize(ASSET_ONNX_PATH) / (1024 * 1024)
    print(f"Successfully exported new ONNX model to:\n  {ASSET_ONNX_PATH} ({size_mb:.2f} MB)")

if __name__ == "__main__":
    train_and_export()
