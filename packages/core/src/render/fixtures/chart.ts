export const hostileChartSource = JSON.stringify({
  type: "bar",
  title: "<script>alert(1)</script>",
  unit: "<x>",
  labels: ["<img src=x onerror=alert(1)>", "javascript:alert(1)"],
  series: [{ name: "<svg onload=alert(1)>", values: [2, 1] }],
});
