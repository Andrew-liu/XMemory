import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/income-desktop')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  XMEMEORY_TEST_DATA: userData
}
delete env.ELECTRON_RUN_AS_NODE

const launch = () =>
  electron.launch({
    ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }),
    env
  })

let app = await launch()
try {
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.waitForLoadState('load')

  // 1. 侧栏点击「生财」进入台账明细视图，且右侧详情栏默认收起
  await page.locator('.sidebar nav').getByRole('button', { name: /生财/ }).click()
  await expect(page.getByRole('tab', { name: '台账明细' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('台账详情')).toHaveCount(0)

  // 2. 点击右上角「记一笔」进入占满工作区的竖版独立页面，录入人民币与美元多分类收入
  await page.locator('.workspace-header').getByRole('button', { name: '记一笔', exact: true }).click()
  await expect(page.getByLabel('记一笔收入')).toBeVisible()
  const entryBorder = await page.getByLabel('记一笔收入').evaluate(el => getComputedStyle(el).borderTopWidth)
  expect(entryBorder).toBe('0px')

  await page.getByLabel('归属日期').fill('2026-11-04')
  await page.getByRole('button', { name: '厂家商单', exact: true }).click()
  await page.getByLabel('事项名称').fill('合成品牌新品首发推文')
  await page.getByLabel('币种').selectOption('CNY')
  await page.getByLabel('金额').fill('3500')
  await page.getByRole('button', { name: '已确定（待交付）' }).click()
  await page.getByLabel('备注与交付说明').fill('合成备注：排期 11 月 6 日')
  await page.getByRole('button', { name: '保存并记入台账' }).click()

  // 保存后自动回到台账明细并显示该笔收入
  await expect(page.getByRole('tab', { name: '台账明细' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('合成品牌新品首发推文').first()).toBeVisible()

  // 再通过记一笔录入一笔美元 X工资（已到账）与一笔 tutti商单（已完成）
  await page.locator('.workspace-header').getByRole('button', { name: '记一笔', exact: true }).click()
  await page.getByLabel('归属日期').fill('2026-11-02')
  await page.getByRole('button', { name: 'X工资', exact: true }).click()
  await page.getByLabel('事项名称').fill('10月下半月 X 创作者分成')
  await page.getByLabel('币种').selectOption('USD')
  await page.getByLabel('金额').fill('400')
  await page.getByRole('button', { name: '已到账（已结清）' }).click()
  await page.getByRole('button', { name: '保存并记入台账' }).click()

  // 收起详情面板验证默认可关闭
  if (await page.getByLabel('收起详情').isVisible()) {
    await page.getByLabel('收起详情').click()
  }
  await expect(page.getByLabel('台账详情')).toHaveCount(0)

  // 3. 验证 11 月速览金额：¥3500 + $400 * 7.2 = ¥3500 + ¥2880 = ¥6,380.00
  await expect(page.getByLabel('速览总收入')).toContainText('¥ 6,380.00')
  await expect(page.getByLabel('速览已到账')).toContainText('¥ 2,880.00')
  await expect(page.getByLabel('速览待收款')).toContainText('¥ 3,500.00')

  // 4. 在台账列表行内一键转换状态：已确定 -> 已完成 -> 已到账，并验证高对比样式与统计联动
  const dealGroup = page.getByRole('group', { name: '合成品牌新品首发推文 状态切换' })
  await dealGroup.getByRole('button', { name: '已完成' }).click()
  await expect(dealGroup.getByRole('button', { name: '已完成' })).toHaveClass(/active-completed/)

  await dealGroup.getByRole('button', { name: '已到账' }).click()
  await expect(dealGroup.getByRole('button', { name: '已到账' })).toHaveClass(/active-received/)
  await expect(page.getByLabel('速览已到账')).toContainText('¥ 6,380.00')
  await expect(page.getByLabel('速览待收款')).toContainText('¥ 0.00')

  // 5. 切换到「统计报表」验证月度/年度汇总与分类排行
  await page.getByRole('tab', { name: '统计报表' }).click()
  await expect(page.getByLabel('统计账面总收入')).toContainText('¥ 6,380.00')
  await expect(page.getByLabel('收入分类构成排行')).toContainText('厂家商单')
  await expect(page.getByLabel('收入分类构成排行')).toContainText('X工资')

  // 切换全年视图并调整汇率 1 USD = 7.00 CNY：¥3500 + $400 * 7.0 = ¥6,300.00
  await page.getByRole('group', { name: '统计月份' }).getByRole('button', { name: '全年' }).click()
  const rateInput = page.getByLabel('美元参考汇率')
  await rateInput.fill('7')
  await rateInput.press('Enter')
  await expect(page.getByLabel('统计账面总收入')).toContainText('¥ 6,300.00')

  await page.screenshot({ path: path.join(temporary, 'income-stats.png') })

  // 6. 重启后状态、汇率与记录完整保留
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.locator('.sidebar nav').getByRole('button', { name: /生财/ }).click()
  await page.getByRole('group', { name: '统计月份' }).getByRole('button', { name: '11月' }).click()
  await expect(page.getByLabel('速览已到账')).toContainText('¥ 6,300.00')
  await page.screenshot({ path: path.join(temporary, 'income-ledger.png') })

  expect(errors).toEqual([])
  console.log('PASS: 生财模块竖版独立记一笔、双币种折算、行内三态强对比切换、月度/年度统计报表与重启持久化')
} finally {
  await app.close()
}
