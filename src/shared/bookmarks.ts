export function bookmarkStopText(reason: string | undefined) {
  switch (reason) {
    case 'limit': return '达到本次上限'
    case 'daily-quota': return '今日额度用完'
    case 'bottom': return '已到书签底部'
    case 'known-streak': return '连续 20 条已存在'
    case 'time': return '达到 30 分钟'
    case 'paused': return '已暂停'
    case 'breaker:auth': return '需要重新登录或验证'
    case 'breaker:rate-limit': return '被限流（冷却中）'
    case 'breaker:api-errors': return '书签接口连续报错'
    case 'breaker:failures': return '连续 3 条采集失败'
    case 'breaker:loop': return '书签列表重复'
    case 'breaker:schema': return '书签页结构已变化'
    default: return reason || ''
  }
}
