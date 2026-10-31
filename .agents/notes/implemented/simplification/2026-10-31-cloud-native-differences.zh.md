# Agent Note: 将云端策略保留在现有云包中

Status: implemented

[English](2026-10-31-cloud-native-differences.md) | 中文

## 问题

云端专用的首页鉴权和普通插件字段权限扩展了原生服务。整体删除原生差异又会丢失通用生命周期修复和异步操作内部的账户隔离检查。

## 决策

现有 access 包的 `/frontend` 入口替换云端 profile 中显式声明的 frontend 行。它复用原生 `serveStatic` 和同一个独占 fallback 注册位；原生 frontend-static 保留 Connection 鉴权。Cloud API 在内部持有普通字段替换策略，原生 Settings 保留秘密值脱敏。云插件编辑器补齐 ConfigField 已有回调，不再改变该控件的必填属性。包数量、服务、进程、账户数据、配额及业务路由准入均不改变。部署迁移见[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/cloud-public-frontend/guide.zh.md)。

## 考虑过的替代方案

**整体回退原生修改。** 这会删除实际关闭、取消、持久化与账户隔离保证。异步提交点外的包装不能替代内部检查。

**将原生实现复制到云包。** 复制 Gateway、存储、Office 或 UI 引擎会增加维护及升级工作，且未降低架构复杂度。

**将认证前浏览器启动搬入动态客户端包。** 这会改变模块身份和启动顺序。不能仅为减少原生文件数，就让共用 schema 入口引入 DOM、React 和 CSS 依赖。

## 影响

云端业务策略有明确拥有者，原生默认行为仍可使用。通用修复和必要接入点在原生提供等价公开能力前保留为小补丁。源码测试验证 HTTP 服务和编辑行为；部署解析、Root 封存及实际登录仍是独立发布检查。公开制品目录和全部首页注入不得含有账户私有数据或秘密值。
