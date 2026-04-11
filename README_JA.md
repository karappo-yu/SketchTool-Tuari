# SketchTool-Tuari

[中文](./README.md) / [English](./README_EN.md)

Tauri + Rust で再構築されたデスクトップスケッチ練習ツールです。元のプロジェクトの基本的な使用方法を維持しながら、macOS のウィンドウ操作、画像スライドショー、平均色背景、グリッドオーバーレイ、ライブラリ体験などを調整しています。

## スクリーンショット

### メイン画面

![メイン画面](./screenshot/index.png)

### ライブラリ

![ライブラリ](./screenshot/library.png)

### スライドショー カウントダウン画面

![スライドショー カウントダウン画面](./screenshot/show.png)

## 機能

- ローカル画像フォルダを選択してスケッチ練習を開始
- ランダム / 順序再生に対応
- マーク済み画像のフィルター機能
- 画像ライブラリのブラウズ、外部で開く、マーク解除
- ミラー、グレースケール、グリッドオーバーレイツール
- 単色、平均色、静的画像背景
- カウントダウン表示と時間形式の切り替え
- デフォルトフォルダ、起動フォルダ、ウィンドウ最前面表示対応
- macOS スタイルのウィンドウドラッグとトラフィックライト表示制御

## 技術スタック

- フロントエンド: Vanilla JavaScript + Vite
- デスクトップ: Tauri 2
- バックエンド: Rust

## 開発

依存関係のインストール：

```bash
npm install
```

開発モードで実行：

```bash
npm run tauri dev
```

## ビルド

デバッグビルド：

```bash
npm run tauri build -- --debug --bundles app
```

リリースビルド：

```bash
npm run tauri build -- --bundles app
```

## プロジェクト構造

```text
src/              フロントエンドロジック
src-tauri/        Tauri と Rust バックエンド
screenshot/       README 用スクリーンショット
index.html        エントリページ
style.css         スタイル
```

## 備考

- このリポジトリは古い Electron 構造を中使用しなくなりました。
- 現在の優先事項は、高リスクの大規模なリファクタリングではなく元の使用感と操作性を維持することです。
