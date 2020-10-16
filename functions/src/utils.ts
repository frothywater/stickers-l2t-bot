import sharp from "sharp"
import { LineSticker, LineStickerSet } from "./typings"

export function isLineSticker(obj: any): obj is LineSticker {
    return (
        "id" in obj &&
        typeof obj.id === "number" &&
        "url" in obj &&
        typeof obj.url === "string" &&
        "emojis" in obj &&
        typeof obj.emojis === "string"
    )
}

export function isLineStickerSet(obj: any): obj is LineStickerSet {
    return (
        "id" in obj &&
        typeof obj.id === "number" &&
        "name" in obj &&
        typeof obj.name === "string" &&
        "author" in obj &&
        typeof obj.author === "string" &&
        "authorUrl" in obj &&
        typeof obj.authorUrl === "string" &&
        "mainImageUrl" in obj &&
        typeof obj.mainImageUrl === "string" &&
        "stickers" in obj &&
        Array.isArray(obj.stickers) &&
        (obj.stickers as any[]).every((sticker) => isLineSticker(sticker))
    )
}

export function formattedName(str: string): string {
    function uniqueId(length: number): string {
        let resultStr = ""
        const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        for (let i = 0; i < length; i++) {
            resultStr += characters.charAt(Math.floor(Math.random() * characters.length))
        }
        return resultStr
    }

    let result = str.replace(/[^\w]/g, "_")
    if (!/^\w/.test(result)) result = "L2T_" + result
    result = `${result}_${uniqueId(6)}_by_stickers_l2t2_bot`
    result = result.split(/_{2,}/).join("")

    return result
}

export function normalizeImage(input: Buffer): Promise<Buffer> {
    return sharp(input)
        .trim()
        .resize(512, 512, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer()
}

export async function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve()
        }, ms)
    })
}

export class BotError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "BotError"
    }
}

export function concurrentDo(
    tasks: (() => Promise<void>)[],
    limit: number,
    interval = 0,
    timeout?: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (tasks.length === 0) {
            return resolve()
        }

        const queue: (Promise<void> | undefined)[] = []
        const taskToBeExcuted = [...tasks]
        const pLimit = limit ?? tasks.length

        fillQueue()
        const timer = setInterval(() => {
            fillQueue()
        }, interval)
        let timeoutTimer: NodeJS.Timer
        if (timeout)
            timeoutTimer = setTimeout(() => {
                clearTimeout(timeoutTimer)
                reject(new BotError("操作超时了"))
            }, timeout)

        function isQueueEmpty(): boolean {
            for (let i = 0; i < pLimit; i++) if (queue[i]) return false
            return true
        }

        function cleanup() {
            clearInterval(timer)
            if (timeoutTimer) clearTimeout(timeoutTimer)
        }

        function fillQueue() {
            for (let i = 0; i < pLimit; i++) {
                if (!queue[i]) {
                    if (taskToBeExcuted.length > 0) {
                        queue[i] = taskToBeExcuted.pop()!()
                            .then(() => {
                                queue[i] = undefined
                                if (taskToBeExcuted.length === 0 && isQueueEmpty()) {
                                    cleanup()
                                    resolve()
                                }
                            })
                            .catch((err) => {
                                cleanup()
                                reject(err)
                            })
                    }
                }
            }
        }
    })
}
