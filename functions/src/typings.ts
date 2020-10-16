export interface LineSticker {
  id: number
  url: string
  emojis: string
  fileId?: string
  image?: Buffer
}

export interface LineStickerSet {
  id: number
  name: string
  author: string
  authorUrl: string
  mainImageUrl: string
  stickers: LineSticker[]
}

export interface FirestoreImageDoc {
  fileId: string
}
