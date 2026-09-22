/**
 * Os quadros.
 *
 * Depois do aperto de mão, tudo que trafega é quadro. O cabeçalho tem **dois
 * bytes** no caso mais comum, e é essa economia que separa um WebSocket de
 * ficar abrindo requisição HTTP atrás de requisição HTTP.
 *
 *   byte 0:  FIN(1) RSV1(1) RSV2(1) RSV3(1) opcode(4)
 *   byte 1:  MASK(1) tamanho(7)
 *   depois:  tamanho estendido (0, 2 ou 8 bytes), máscara (0 ou 4), carga
 *
 * Duas regras da RFC que este arquivo faz valer e que parecem detalhe até
 * derrubarem uma conexão em produção:
 *
 * 1. O cliente **tem** que mascarar; o servidor **não pode**. Não é
 *    criptografia (a chave vai no próprio quadro): é para impedir que um
 *    cliente hostil faça o navegador emitir bytes que um proxy velho leia
 *    como se fossem uma requisição HTTP dele.
 * 2. Quadro de controle cabe em 125 bytes e nunca é fragmentado, porque
 *    precisa poder ser respondido no meio de uma mensagem grande.
 */

/** Os códigos de operação da RFC 6455. */
export const OPCODES = {
  continuacao: 0x0,
  texto: 0x1,
  binario: 0x2,
  fechar: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/** Nome legível a partir do código. */
export const NOMES = Object.fromEntries(Object.entries(OPCODES).map(([nome, codigo]) => [codigo, nome]));

/** Quadros de controle: os que têm o bit mais alto do opcode ligado. */
export function ehControle(opcode) {
  return (opcode & 0x8) !== 0;
}

/** Tamanho máximo de um quadro de controle, pela RFC. */
export const MAXIMO_DE_CONTROLE = 125;

/** Um quadro chegou fora do protocolo. `codigo` vira o motivo do fechamento. */
export class ErroDeProtocolo extends Error {
  constructor(mensagem, codigo = 1002) {
    super(mensagem);
    this.name = 'ErroDeProtocolo';
    this.codigo = codigo;
  }
}

/**
 * Aplica a máscara XOR de 4 bytes.
 *
 * A mesma função serve para mascarar e desmascarar — XOR é o seu próprio
 * inverso, e é por isso que não existe "desmascarar" separado.
 */
export function mascarar(carga, chave) {
  const saida = Buffer.allocUnsafe(carga.length);

  for (let i = 0; i < carga.length; i += 1) saida[i] = carga[i] ^ chave[i % 4];

  return saida;
}

/**
 * Lê um quadro do começo do buffer.
 *
 * Devolve `null` quando ainda não chegou tudo — é o caso normal num fluxo
 * TCP, onde um `data` pode trazer meio cabeçalho. Quem chama acumula e tenta
 * de novo.
 */
export function lerQuadro(dados, { maximo = 64 * 1024 * 1024 } = {}) {
  if (dados.length < 2) return null;

  const primeiro = dados[0];
  const segundo = dados[1];

  const fin = (primeiro & 0x80) !== 0;
  const reservados = primeiro & 0x70;
  const opcode = primeiro & 0x0f;
  const mascarado = (segundo & 0x80) !== 0;

  // Sem extensão negociada, RSV ligado é quadro de outro protocolo.
  if (reservados !== 0) throw new ErroDeProtocolo('Bits RSV ligados sem extensão negociada.');

  if (!(opcode in NOMES)) throw new ErroDeProtocolo(`Opcode desconhecido: 0x${opcode.toString(16)}.`);

  let tamanho = segundo & 0x7f;
  let cursor = 2;

  if (tamanho === 126) {
    if (dados.length < cursor + 2) return null;

    tamanho = dados.readUInt16BE(cursor);
    cursor += 2;
  } else if (tamanho === 127) {
    if (dados.length < cursor + 8) return null;

    const grande = dados.readBigUInt64BE(cursor);

    if (grande > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ErroDeProtocolo('Quadro grande demais para ser endereçado.', 1009);
    }

    tamanho = Number(grande);
    cursor += 8;
  }

  if (ehControle(opcode)) {
    if (tamanho > MAXIMO_DE_CONTROLE) {
      throw new ErroDeProtocolo(`Quadro de controle com ${tamanho} bytes; o limite é ${MAXIMO_DE_CONTROLE}.`);
    }

    // Controle fragmentado nunca poderia ser respondido no meio de uma
    // mensagem grande, que é justamente para o que ele serve.
    if (!fin) throw new ErroDeProtocolo('Quadro de controle fragmentado.');
  }

  if (tamanho > maximo) {
    throw new ErroDeProtocolo(`Quadro de ${tamanho} bytes passa do limite de ${maximo}.`, 1009);
  }

  let chave = null;

  if (mascarado) {
    if (dados.length < cursor + 4) return null;

    chave = dados.subarray(cursor, cursor + 4);
    cursor += 4;
  }

  if (dados.length < cursor + tamanho) return null;

  const bruta = dados.subarray(cursor, cursor + tamanho);

  return {
    quadro: {
      fin,
      opcode,
      nome: NOMES[opcode],
      mascarado,
      carga: mascarado ? mascarar(bruta, chave) : Buffer.from(bruta),
    },
    consumido: cursor + tamanho,
  };
}

/** Monta os bytes de um quadro. */
export function montarQuadro({ fin = true, opcode = OPCODES.texto, carga = Buffer.alloc(0), chave = null }) {
  const corpo = Buffer.isBuffer(carga) ? carga : Buffer.from(String(carga));

  if (ehControle(opcode)) {
    if (corpo.length > MAXIMO_DE_CONTROLE) {
      throw new ErroDeProtocolo(`Quadro de controle com ${corpo.length} bytes; o limite é ${MAXIMO_DE_CONTROLE}.`);
    }

    if (!fin) throw new ErroDeProtocolo('Quadro de controle não pode ser fragmentado.');
  }

  const mascarado = chave !== null;

  let extra = 0;
  let indicador = corpo.length;

  if (corpo.length > 0xffff) {
    indicador = 127;
    extra = 8;
  } else if (corpo.length > MAXIMO_DE_CONTROLE) {
    indicador = 126;
    extra = 2;
  }

  const cabecalho = Buffer.allocUnsafe(2 + extra + (mascarado ? 4 : 0));

  cabecalho[0] = (fin ? 0x80 : 0) | opcode;
  cabecalho[1] = (mascarado ? 0x80 : 0) | indicador;

  if (indicador === 126) cabecalho.writeUInt16BE(corpo.length, 2);
  else if (indicador === 127) cabecalho.writeBigUInt64BE(BigInt(corpo.length), 2);

  if (!mascarado) return Buffer.concat([cabecalho, corpo]);

  chave.copy(cabecalho, 2 + extra);

  return Buffer.concat([cabecalho, mascarar(corpo, chave)]);
}

/** Códigos de fechamento da RFC que este projeto usa. */
export const FECHAMENTO = {
  normal: 1000,
  saindo: 1001,
  protocolo: 1002,
  tipoInaceitavel: 1003,
  semCodigo: 1005,
  quedaAnormal: 1006,
  dadosInvalidos: 1007,
  politica: 1008,
  grandeDemais: 1009,
  erroInterno: 1011,
};

/**
 * Códigos que nunca podem vir num quadro de fechamento.
 *
 * 1005 e 1006 existem só para a aplicação local descrever o que houve; se
 * chegarem pela rede, o outro lado está inventando.
 */
export const RESERVADOS = [1004, FECHAMENTO.semCodigo, FECHAMENTO.quedaAnormal, 1015];

/** Monta a carga de um quadro de fechamento: código de 2 bytes + motivo. */
export function cargaDeFechamento(codigo = FECHAMENTO.normal, motivo = '') {
  const texto = Buffer.from(motivo, 'utf8');

  if (2 + texto.length > MAXIMO_DE_CONTROLE) {
    throw new ErroDeProtocolo('O motivo do fechamento não cabe num quadro de controle.');
  }

  const carga = Buffer.allocUnsafe(2 + texto.length);

  carga.writeUInt16BE(codigo, 0);
  texto.copy(carga, 2);

  return carga;
}

/** Lê a carga de um fechamento. Fechar sem dizer nada é permitido. */
export function lerFechamento(carga) {
  if (carga.length === 0) return { codigo: FECHAMENTO.semCodigo, motivo: '' };

  // Um byte só não forma um código: ou vêm os dois, ou não vem nenhum.
  if (carga.length === 1) throw new ErroDeProtocolo('Quadro de fechamento com 1 byte de carga.');

  const codigo = carga.readUInt16BE(0);

  if (RESERVADOS.includes(codigo) || codigo < 1000 || (codigo >= 1016 && codigo < 3000)) {
    throw new ErroDeProtocolo(`Código de fechamento inválido: ${codigo}.`);
  }

  return { codigo, motivo: carga.subarray(2).toString('utf8') };
}
