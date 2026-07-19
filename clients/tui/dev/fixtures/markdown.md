# Markdown Fixture

review:

`inline code wraps across the pane`

```rust
fn main() {
    println!("hello");
}
```

1. numbered list item wraps across the pane
2. second item
- bullet list item wraps too
- [x] task item

> quoted text that should keep its quote prefix while wrapping.

| feature | expected |
|---|---|
| markdown | rendered |
| scroll | clean repaint |
