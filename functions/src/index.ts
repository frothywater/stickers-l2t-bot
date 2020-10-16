import { PubSub } from "@google-cloud/pubsub"
import Axios from "axios"
import * as admin from "firebase-admin"
import * as functions from "firebase-functions"
import Telegraf from "telegraf"
import serviceAccount from "./serviceAccountKey.json"
import { FirestoreImageDoc, LineSticker, LineStickerSet } from "./typings"
import { BotError, concurrentDo, delay, formattedName, isLineStickerSet, normalizeImage } from "./utils"

const welcomeText =
    "你好～ 这是一个可以把 Line 贴纸转换到 Telegram 来的 bot。\
    我为你准备了[一个编辑器](https://stickers-l2t-editor.vercel.app)，你可以在那里编辑贴纸包。\
    编辑器会为你生成一个 JSON 文件，然后拖到这里来，我就会开始工作。"

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as any),
    databaseURL: JSON.parse(process.env.FIREBASE_CONFIG!).databaseURL,
})

const db = admin.firestore()
const token = functions.config().bot.token
const secretPath = functions.config().bot.secret_path
const bot = new Telegraf(token)
const axios = Axios.create({ responseType: "arraybuffer" })
const processingChat: Record<number, boolean> = {}

bot.start((ctx) => ctx.reply(welcomeText, { parse_mode: "Markdown" }))

bot.on("document", async (ctx) => {
    const userId = ctx.from?.id!

    try {
        if (processingChat[userId]) {
            throw new BotError("我已经在吭哧吭哧地工作了，请等我把工作先做完！")
        } else {
            processingChat[userId] = true
            await ctx.reply("收到贴纸包文件～ 请耐心等待哦，整个过程至少需要一分钟。")
        }

        const stickerSet = await fetchStickerSetObject()
        const setName = formattedName(stickerSet.name)
        const title = `${stickerSet.name} (by ${stickerSet.author})`

        const existingImageIds = await retrieveImageIds()
        const stickersAlreadyUploaded: LineSticker[] = []
        const stickersToBeUploaded: LineSticker[] = []
        stickerSet.stickers.forEach((sticker) => {
            if (existingImageIds[sticker.id]) {
                sticker.fileId = existingImageIds[sticker.id]
                stickersAlreadyUploaded.push(sticker)
            } else stickersToBeUploaded.push(sticker)
        })

        await downloadStickers()
        await processStickers()
        await uploadStickers()
        await addImageIds(stickersToBeUploaded)
        await delay(1000)
        await createStickerSet()
        await delay(8000)
        await addStickers()

        processingChat[userId] = false
        await log(`成功啦🥳！ 这就是你的贴纸包: [${stickerSet.name}](https://t.me/addstickers/${setName})`)

        async function fetchStickerSetObject(): Promise<LineStickerSet> {
            const link = await ctx.telegram.getFileLink(ctx.message?.document?.file_id!)

            const json = ((await axios.get(link)).data as Buffer).toString("utf8")
            const result = JSON.parse(json)
            if (isLineStickerSet(result)) return result
            else throw new BotError("This file seems wrong... Please send a correct file.")
        }

        async function retrieveImageIds(): Promise<Record<number, string>> {
            const snapshot = await db.collection("images").get()
            const result: Record<number, string> = {}
            snapshot.docs.forEach((doc) => {
                result[parseInt(doc.id)] = (doc.data() as FirestoreImageDoc).fileId
            })
            return result
        }

        async function downloadStickers(): Promise<void> {
            await log("正在从 Line 下载贴纸...")
            await concurrentDo(
                stickersToBeUploaded.map((sticker) => () =>
                    downloadSticker(sticker.url).then((image) => {
                        sticker.image = image
                    })
                ),
                5,
                300,
                20000
            )
            await log("贴纸下载好了。")

            async function downloadSticker(url: string): Promise<Buffer> {
                let error: any
                let times = 0
                while (times < 3) {
                    try {
                        const result = await __downloadSticker()
                        return result
                    } catch (err) {
                        times++
                        error = err
                    }
                }
                if (error) console.log(error)
                console.log(`Failed: ${url}.`)
                throw new BotError("下载贴纸时出错了")

                function __downloadSticker(): Promise<any> {
                    return axios.get(url).then((response) => response.data)
                }
            }
        }

        async function processStickers(): Promise<void> {
            await log("正在缩放贴纸图片...")
            await Promise.all(
                stickersToBeUploaded.map(async (sticker) => {
                    sticker.image = await normalizeImage(sticker.image!)
                })
            )
            await log("贴纸图片都处理好了。")
        }

        async function uploadStickers(): Promise<void> {
            await log("正在上传贴纸到 Telegram 服务器...")
            await concurrentDo(
                stickersToBeUploaded.map((sticker) => () => uploadSticker(sticker)),
                5,
                1800,
                60000
            )
            await log("贴纸都上传好了。")

            async function uploadSticker(sticker: LineSticker): Promise<void> {
                let error: any
                let times = 0
                while (times < 3) {
                    try {
                        const { file_id } = await __uploadSticker()
                        sticker.fileId = file_id
                        // console.log(`Finished: ${sticker.id}.`)
                        return
                    } catch (err) {
                        times++
                        error = err
                        await delay(1000)
                    }
                }
                if (error) console.log(error)
                throw new BotError("上传贴纸时出错了")

                function __uploadSticker() {
                    return ctx.telegram.uploadStickerFile(userId, {
                        source: sticker.image!,
                    })
                }
            }
        }

        async function addImageIds(stickers: LineSticker[]): Promise<void> {
            const batch = db.batch()
            stickers.forEach((sticker) => {
                if (sticker.fileId) {
                    const ref = db.collection("images").doc(sticker.id.toString())
                    const data: FirestoreImageDoc = { fileId: sticker.fileId }
                    batch.set(ref, data)
                }
            })
            await batch.commit()
        }

        async function createStickerSet(): Promise<void> {
            const firstSticker = stickerSet.stickers[0]
            await ctx.telegram.createNewStickerSet(userId, setName, title, {
                png_sticker: firstSticker.fileId!,
                emojis: firstSticker.emojis,
            } as any)
            await log(`创建了一个新的贴纸包。`)
        }

        async function addStickers(): Promise<void> {
            await log("正在把贴纸们加进贴纸包里。")
            await concurrentDo(
                stickerSet.stickers.slice(1).map((sticker) => () => addSticker(sticker)),
                2,
                1500,
                80000
            )

            async function addSticker(sticker: LineSticker): Promise<void> {
                let error: any
                let times = 0
                while (times < 5) {
                    try {
                        await __addSticker()
                        // console.log(`Added: ${sticker.id}.`)
                        return
                    } catch (err) {
                        times++
                        error = err

                        await delay(1000)
                    }
                }
                if (error) console.log(error)
                throw new BotError("把贴纸们加进贴纸包时出错了")

                function __addSticker() {
                    return ctx.telegram.addStickerToSet(
                        userId,
                        setName,
                        {
                            png_sticker: sticker.fileId!,
                            emojis: sticker.emojis,
                        } as any,
                        false
                    )
                }
            }
        }

        async function log(str: string): Promise<void> {
            await ctx.reply(str, { parse_mode: "Markdown" })
            console.log(`[${userId}] ${str}`)
        }
    } catch (err) {
        processingChat[userId] = false
        if (err instanceof BotError) {
            console.log(err.message)
            await ctx.reply(`糟糕，${err.message}😣！...再试一次吧～`)
        } else {
            console.log(err)
            await ctx.reply(`奇怪的事情，发生了😣！...再试一次吧～`)
        }
    }
})

const pubsub = new PubSub()
const topicName = "main"
const bkgRuntimeOptions: functions.RuntimeOptions = {
    timeoutSeconds: 300,
    memory: "1GB",
}

export const listen = functions.https.onRequest(async (req, res) => {
    const path = req.path.trim()
    if (path === secretPath) {
        const topic = pubsub.topic(topicName)
        const message = Buffer.from(JSON.stringify(req.body), "utf-8")

        try {
            await topic.publish(message)
            console.log("Received request and published pubsub message.")
        } catch (err) {
            console.log(err)
        } finally {
            res.sendStatus(200)
        }
    } else res.sendStatus(404)
})

export const background = functions
    .runWith(bkgRuntimeOptions)
    .pubsub.topic(topicName)
    .onPublish(async (message) => {
        await bot.handleUpdate(message.json)
    })

export const test = functions.https.onRequest(async (req, res) => {
    const url = req.query.url?.toString()
    if (url) {
        const response = await axios.get(url)
        res.header(response.headers).status(response.status).send(response.data)
    }
})
