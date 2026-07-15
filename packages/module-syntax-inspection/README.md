# Module syntax inspection

This private workspace provides the shared syntax-tree module-reference inspection used by the standards CLI and release boundary tests. It deliberately recognizes only statically resolvable module specifiers so boundary checks fail closed when a loader expression is opaque.

The package consumes no configuration values or secrets.
