// MiniMax coding plan usage provider
// Endpoints: GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains
//            GET https://www.minimax.io/v1/api/openplatform/coding_plan/remains (fallback)
// Auth: Authorization: Bearer {apiKey}

import { getApiKey, hasCredential } from './auth.js'
import { fetchWithTimeout } from './types.js'
import type { ProviderResult, UsageProvider, UsageWindow } from './types.js'

const ENDPOINTS = [
	'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
	'https://www.minimax.io/v1/api/openplatform/coding_plan/remains',
]
const AUTH_KEY = 'minimax-coding-plan'

interface ModelRemain {
	model_name: string
	start_time: string
	end_time: string
	remains_time: number
	current_interval_total_count: number
	current_interval_usage_count: number
	current_weekly_total_count: number
	current_weekly_usage_count: number
	weekly_start_time: string
	weekly_end_time: string
}

interface MiniMaxResponse {
	model_remains: ModelRemain[]
	base_resp?: { status_code: number; status_msg: string }
}

export const miniMaxProvider: UsageProvider = {
	id: 'minimax',
	name: 'MiniMax',
	billingType: 'quotaBased',

	async isConfigured(): Promise<boolean> {
		return hasCredential(AUTH_KEY)
	},

	async fetchUsage(): Promise<ProviderResult> {
		const apiKey = getApiKey(AUTH_KEY)
		if (!apiKey) {
			return {
				providerId: this.id,
				providerName: this.name,
				billingType: this.billingType,
				status: 'not_configured',
				fetchedAt: Date.now(),
			}
		}

		// Try endpoints with fallback
		let lastError = ''
		for (const endpoint of ENDPOINTS) {
			try {
				const res = await fetchWithTimeout(endpoint, {
					headers: { Authorization: `Bearer ${apiKey}` },
				})

				if (!res.ok) {
					lastError = `HTTP ${res.status}`
					continue
				}

				const json = (await res.json()) as MiniMaxResponse

				if (json.base_resp && json.base_resp.status_code !== 0) {
					lastError = json.base_resp.status_msg || `Status code ${json.base_resp.status_code}`
					continue
				}

				const windows: UsageWindow[] = []
				let maxUtilization = 0

				for (const model of json.model_remains || []) {
					// 5h window
					if (model.current_interval_total_count > 0) {
						const util5h = (model.current_interval_usage_count / model.current_interval_total_count) * 100
						windows.push({
							utilization: util5h,
							resetsAt: model.end_time ? new Date(model.end_time).getTime() : undefined,
							label: `${model.model_name} 5h`,
						})
						maxUtilization = Math.max(maxUtilization, util5h)
					}

					// Weekly window
					if (model.current_weekly_total_count > 0) {
						const utilWeekly = (model.current_weekly_usage_count / model.current_weekly_total_count) * 100
						windows.push({
							utilization: utilWeekly,
							resetsAt: model.weekly_end_time ? new Date(model.weekly_end_time).getTime() : undefined,
							label: `${model.model_name} weekly`,
						})
						maxUtilization = Math.max(maxUtilization, utilWeekly)
					}
				}

				return {
					providerId: this.id,
					providerName: this.name,
					billingType: this.billingType,
					status: 'ok',
					usage: {
						type: 'quotaBased',
						utilization: maxUtilization,
						windows,
					},
					fetchedAt: Date.now(),
				}
			} catch (err) {
				lastError = `${err}`
				continue
			}
		}

		return {
			providerId: this.id,
			providerName: this.name,
			billingType: this.billingType,
			status: 'error',
			error: lastError,
			fetchedAt: Date.now(),
		}
	},
}
