//go:build race

package plugin

// The race detector instruments every line of the pure-Go QuickJS; give calls room (see callBudget).
func init() {
	callBudget *= 10
	startBudget *= 10
}
