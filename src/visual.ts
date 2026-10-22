// Visual do app: a marca Enche AI (verde-mata, verde-broto, Bricolage e Instrument), padrão para todos.
// As regras ficam em src/visual-novo.css sob a classe v2, que o próprio <html> já traz.
// isNovo() continua existindo para os trechos de tela que só existem no visual novo.
export const isNovo = () => true;

export function applyVisual() {
  document.documentElement.classList.add('v2');
}

/** Logo: a gota. */
export const DROP = (size = 24, fill = 'currentColor') =>
  '<svg aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 48 48"><path d="M24 3.5C24 3.5 9.5 19.6 9.5 29.8 9.5 37.8 16 44.3 24 44.3S38.5 37.8 38.5 29.8C38.5 19.6 24 3.5 24 3.5Z" fill="' + fill + '"/></svg>';
