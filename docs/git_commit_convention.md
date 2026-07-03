# Git Commit 规范

提交信息使用中文，格式参考 Conventional Commits：

```text
<type>(<scope>): <中文简短说明>

<中文正文，可选>

<footer，可选>
```

## 基本规则

- `type` 使用英文小写，`scope` 可选，说明本次提交影响的模块。
- 简短说明使用中文，控制在 50 个中文字符以内，不以句号结尾。
- 一个 commit 只做一件事，避免把无关修改混在一起。
- 需要说明背景、取舍、风险时写正文；正文用中文描述“为什么改”和“影响什么”。
- 关联需求或缺陷时写在 footer，例如 `Closes #123`。
- 破坏兼容时必须写 `BREAKING CHANGE: <中文说明>`。

## 常用 type

| type | 使用场景 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档修改 |
| `style` | 代码格式、空白、命名等不影响逻辑的修改 |
| `refactor` | 重构，不新增功能也不修复缺陷 |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `build` | 构建系统、依赖、打包配置 |
| `ci` | CI/CD 配置 |
| `chore` | 维护性杂项 |
| `revert` | 回滚提交 |

## 示例

```text
feat(video): 增加异步任务恢复
fix(volcengine): 修复火山轮询提前超时
docs: 增加 Git Commit 规范
refactor(core): 简化请求重试逻辑
test(volcengine): 补充模型映射自检
```

带正文的示例：

```text
fix(volcengine): 修复火山任务过期时间过短

部分视频任务排队超过默认过期时间后会被上游标记为 expired。
现在创建任务时显式传入过期时间，避免依赖上游默认值。

Closes #123
```
