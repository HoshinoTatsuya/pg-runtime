/** Коды, которыми сервер сообщает о конце сессии, а не об отказе запроса. */
export const SESSION_ENDING_SQLSTATE: readonly string[] = Object.freeze(['57P01', '57P02', '57P03']);
