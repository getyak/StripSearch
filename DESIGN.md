---
name: StripSearch evidence reading
description: Existing paper and forest-green reading system
colors:
  paper: "#f3f1e9"
  surface: "#fffef8"
  secondary-surface: "#e8ede2"
  ink: "#243a31"
  muted: "#58675e"
  primary: "#2d5241"
  dark-paper: "#151d19"
  dark-surface: "#1c2721"
  dark-ink: "#e7ede5"
  dark-primary: "#a9cfb3"
rounded:
  control: "8px"
  input: "12px"
spacing:
  tight: "8px"
  group: "16px"
  section: "24px"
---

# StripSearch 阅读系统

## Overview

这里记录已实施的“证据阅览室”基线，来源为 [Web 设计](docs/web-design.md) 与 `apps/web/src/client/styles.css`。GET-288 保留既有纸白、森林绿及本地字体；不是新配色提案。Read / Operate 工作面以材料、出处及可修订状态为主。

## Colors

纸白是既有阅读环境，深色模式使用墨绿环境。绿色只用于动作、选中与引用关系。未知与待复核沿用既有语义颜色，不能只靠颜色表达状态。

## Typography

界面沿用本地系统中文 sans；标题依靠尺寸与字重分级。正文和原文保持可换行的阅读宽度。技术标识可以使用原有 mono，普通研究内容不排成终端日志。

## Layout

Search 主阅读区与按需出处面板分层，1220px 以下沿用原生出处抽屉。Fetch 按问题、真实状态、待核原文、缺口、限制、运行记录排列。DOM 顺序与视觉顺序一致，记录使用原生 details，44px 触控目标与可见焦点保持。

## Elevation & Depth

工作面以细分隔和间距组织材料，不新增阴影卡片或装饰动效。

## Shapes

沿用 8px 操作与 12px 输入圆角；细边线表达分组和已有状态。

## Components

结论旁的稳定引用打开出处并能返回原句。来源身份、不确定性、限制、撤回影响与修订操作保持可见。请求统计、版本和获取时间按需查看，不挤占原文。

## Do's and Don'ts

保留真实错误与恢复条件，不把待核材料标成事实，不编造头像、指标或平台能力。不得为通过审美检测替换用户已确认的纸面配色。
