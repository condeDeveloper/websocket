/**
 * O aperto de mão.
 *
 * Um WebSocket começa como um GET comum. O servidor responde `101 Switching
 * Protocols` e, a partir daí, o mesmo soquete TCP deixa de falar HTTP e passa
 * a falar quadros. É por isso que WebSocket atravessa proxy e firewall que só
 * conhecem a porta 443: a abertura é indistinguível de uma requisição normal.
 *
 * O cliente manda uma chave aleatória; o servidor devolve o SHA-1 dela
 * concatenada a um texto fixo da RFC. Isso **não é segurança** — a constante
 * é pública. Serve só para provar que do outro lado há algo que entende
 * WebSocket, e não um cache ou um proxy antigo devolvendo uma resposta
 * guardada.
 */

import { createHash, randomBytes } from 'node:crypto';

/** A constante da RFC 6455. É pública de propósito. */
export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A única versão do protocolo que existe. */
export const VERSAO = 13;

/** O aperto de mão não pôde ser feito. */
export class ErroDeAperto extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.name = 'ErroDeAperto';
    this.status = status;
  }
}

/** A resposta que prova que do outro lado tem um WebSocket. */
export function respostaPara(chave) {
  if (typeof chave !== 'string' || chave.length === 0) {
    throw new ErroDeAperto('Falta o cabeçalho Sec-WebSocket-Key.');
  }

  return createHash('sha1').update(chave + GUID).digest('base64');
}

/** Uma chave nova: 16 bytes aleatórios em base64, como manda a RFC. */
export function chaveNova() {
  return randomBytes(16).toString('base64');
}

/** Lê um cabeçalho sem se importar com maiúsculas. */
function cabecalho(cabecalhos, nome) {
  const valor = cabecalhos[nome] ?? cabecalhos[nome.toLowerCase()];

  return Array.isArray(valor) ? valor.join(', ') : valor;
}

/**
 * Confere se a requisição é mesmo um pedido de upgrade válido.
 *
 * Recusar cedo e com o motivo certo é o que evita o erro mais chato de
 * depurar em WebSocket: o soquete que abre, fica mudo e cai sem explicação.
 */
export function conferirPedido(requisicao) {
  const cabecalhos = requisicao.headers ?? {};

  if (requisicao.method && requisicao.method !== 'GET') {
    throw new ErroDeAperto(`O upgrade tem que ser GET, veio ${requisicao.method}.`, 405);
  }

  const upgrade = cabecalho(cabecalhos, 'upgrade');

  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    throw new ErroDeAperto('Cabeçalho Upgrade ausente ou diferente de "websocket".');
  }

  const conexao = cabecalho(cabecalhos, 'connection') ?? '';

  // Pode vir "keep-alive, Upgrade" quando há proxy no caminho.
  if (!conexao.toLowerCase().split(',').some((parte) => parte.trim() === 'upgrade')) {
    throw new ErroDeAperto('Cabeçalho Connection não pede upgrade.');
  }

  const versao = Number(cabecalho(cabecalhos, 'sec-websocket-version'));

  if (versao !== VERSAO) {
    throw new ErroDeAperto(`Só a versão ${VERSAO} existe; veio ${cabecalho(cabecalhos, 'sec-websocket-version')}.`, 426);
  }

  const chave = cabecalho(cabecalhos, 'sec-websocket-key');

  if (!chave) throw new ErroDeAperto('Falta o cabeçalho Sec-WebSocket-Key.');

  // 16 bytes em base64 dão sempre 24 caracteres. Chave de outro tamanho é
  // cliente quebrado, não cliente diferente.
  if (Buffer.from(chave, 'base64').length !== 16) {
    throw new ErroDeAperto('Sec-WebSocket-Key precisa ser 16 bytes em base64.');
  }

  return {
    chave,
    protocolos: (cabecalho(cabecalhos, 'sec-websocket-protocol') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  };
}

/** Monta a resposta 101 que troca o protocolo. */
export function resposta101(chave, { protocolo = null } = {}) {
  const linhas = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${respostaPara(chave)}`,
  ];

  if (protocolo) linhas.push(`Sec-WebSocket-Protocol: ${protocolo}`);

  return `${linhas.join('\r\n')}\r\n\r\n`;
}

/** Monta a resposta de recusa, para o cliente saber por que não abriu. */
export function respostaDeRecusa(erro) {
  const status = erro instanceof ErroDeAperto ? erro.status : 400;
  const motivo = erro?.message ?? 'Pedido inválido.';
  const corpo = `${motivo}\n`;

  const linhas = [
    `HTTP/1.1 ${status} ${status === 426 ? 'Upgrade Required' : 'Bad Request'}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(corpo)}`,
    'Connection: close',
  ];

  if (status === 426) linhas.push(`Sec-WebSocket-Version: ${VERSAO}`);

  return `${linhas.join('\r\n')}\r\n\r\n${corpo}`;
}

/** Escolhe um subprotocolo entre os que o cliente ofereceu. */
export function escolherProtocolo(oferecidos, aceitos) {
  if (!aceitos || aceitos.length === 0) return null;

  // A preferência é do **servidor**: é ele que sabe qual sabe falar melhor.
  return aceitos.find((aceito) => oferecidos.includes(aceito)) ?? null;
}
