---
name: "🚀 抢占式开发工单 (Zero-Context Ready Task)"
about: "符合 DoR 准入标准的可执行契约包，支持无历史上下文开发者或智能体直接抢占开工"
title: "[DOMAIN] 动作: 简要业务目标"
labels: ["status: ready"]
assignees: ""
---

<!-- 
【抢占式工单填写指南】
本工单必须满足「零上下文抢占式开工」要求：
任何新加入的工程师或独立 Cloud Agent，在无需询问任何前置背景的情况下，仅凭本单即可完整交付并闭环测试。
凡字段不全、契约模糊或缺少测试命令者，一律标记为 status: draft，严禁启动编码。
-->

## 1. 爆破点与拓扑边界 (Target Seams & Blast Radius)
*明确规定本次任务允许触碰的最小范围，多改一行即属越界。*
- **允许修改/新增的文件 (Target Seams)**:
  - `path/to/file1.go` (职责: xxx)
  - `path/to/file2.ts` (职责: xxx)
- **严格禁止修改的文件 (Protected Files)**:
  - `internal/provider/hostenergy/gracespark/*` (底层硬件 SPBM 驱动保持稳定)
- **上下游受控依赖**:
  - 上游触发入口 (API / UI Trigger): `xxx`
  - 下游消费方 (State Store / Downstream Consumer): `xxx`

---

## 2. 确定性前置条件 (Hermetic Preconditions)
*明确指出如何将系统一键还原为该任务的基准测试态。*
- **硬件与驱动基线**:
  - GB10 SPBM hwmon 驱动就绪，`/sys/class/hwmon/...` 可正常读取 microjoules
- **基准测试数据锚点 / 环境变量**:
  - `OPENAI_BASE_URL`: `http://127.0.0.1:8090/t/{task_id}/v1`

---

## 3. 代码级数据契约 (Data Contract & Schemas)
*禁止使用文字泛泛描述字段，必须提供代码级强校验 Schema (TypeScript Zod 或 Go Struct)。*

### 3.1 输入契约 (Request Payload / Input Config)
```go
// 或 TypeScript Zod Schema
type TargetRequest struct {
    TaskID string `json:"task_id"`
}
```

### 3.2 预期输出契约 (Response Data / Output Bill)
```go
type TargetResponse struct {
    // 必须精确定义返回的数据结构
}
```

### 3.3 非法与边界拦截用例 (Fail-Fast Test Cases)
| 序号 | 非法输入 / 异常边界样例 | 预期抛出 / 返回的错误码或防御行为 | 预期防护目标 |
| :--- | :--- | :--- | :--- |
| 1 | `{ ... }` | `400 INVALID_PAYLOAD` | 拦截非法输入 |
| 2 | `delta < 0` (硬件计数器溢出/抖动) | 标记 `invalid: true`，截断为 0 | 杜绝产生负能量或虚假能耗 |

---

## 4. 状态机真值表与交互流 (State Machine Truth Table)
*所有涉及异步、运算、进程生命周期或多步交互的模块，必须定义完备的有限状态机 (FSM)。*

| 当前状态 | 触发事件 / 操作 | 目标状态 | 伴随动作 / 数据落盘 | 异常流向 | 前端 UI 表现 / 系统交互约束 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `IDLE` | `TRIGGER_EVENT` | `RUNNING` | 记录基准 T1, E1 | -> `FAILED` | 按钮进入 Loading 态，禁用重复点击 |
| `RUNNING` | `SUCCESS_EVENT` | `SETTLED` | 汇总结算能耗 | -> `FAILED` | 渲染结构化结果卡片，解除锁定 |
| `FAILED` | `RETRY_EVENT` | `RUNNING` | 重试初始化 | -> `TERMINATED`| 标红提示真实错误原因，露出重试 CTA |

---

## 5. 核心不变量与禁止项 (Invariants & Non-Goals)
*明确本工单不可触碰的红线与明确不做的边界。*
- **必须守护的业务不变量 (Invariants)**:
  - [ ] 守恒规则：必须扣除基准静息底噪 (P_idle * duration)，严禁将系统底噪直接归因于 Agent
  - [ ] 真实测试：严禁在硬件/服务不可用时注入 Mock 数据假冒成功，必须 Fail Fast
- **明确不做的事 (Explicit Non-Goals)**:
  - ❌ 本期不重构 upstream 核心调度流程
  - ❌ 本期不引入复杂多租户容器沙箱

---

## 6. 红灯测试规格与单行验证命令 (Red-First Verification)
*没有单行可执行的验证命令，本工单绝不准入。*
- **指定测试用例文件**: `path/to/test.go`
- **开工前红灯验证 (Red Check)**:
  ```bash
  # 动手写代码前，必须先写测试断言，执行此命令必须非 0 退出（报红）
  go test -v -run TestContractXXX ./...
  ```
- **完工后绿灯验证 (Green Check)**:
  ```bash
  # 业务代码完成后，执行此命令必须退出码为 0（全绿）
  go test -v -race ./...
  ```

---

## 7. 事前声明的验收铁证 (Proof Upfront Statement)
> **一句话验收声明**：  
> 本任务完成后，在提交 PR 时，我承诺必须挂载确切的证据：`[例如：附带单测红转绿日志、实机运行前后功耗对比数据表、真实前端界面渲染截图]`。
